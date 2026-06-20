#!/usr/bin/env python3
"""BFS frontier explorer for the TurtleBot 4 (guide-mate).

Subscribes to the SLAM occupancy grid, runs a breadth-first search outward from
the robot's current cell through free space, and detects *frontiers* (free cells
that touch unknown space). Because BFS expands in order of increasing distance,
the first frontier reached is the nearest reachable one -- this is what gives the
explorer its "explore in BFS manner" behaviour. The nearest frontier cluster is
sent to Nav2 as a NavigateToPose goal; Nav2 owns obstacle avoidance and motion.

When a goal succeeds or fails the explorer immediately replans against the latest
map. Frontiers that Nav2 cannot reach are blacklisted so the robot does not get
stuck retrying them. Exploration is declared complete when no valid frontier
remains for several consecutive planning cycles.
"""

import math
import os
import subprocess
import threading
from collections import deque

import numpy as np
import rclpy
from rclpy.action import ActionClient
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import (QoSDurabilityPolicy, QoSHistoryPolicy, QoSProfile,
                       QoSReliabilityPolicy)

from geometry_msgs.msg import Point, PointStamped, PoseStamped
from nav2_msgs.action import NavigateToPose
from nav_msgs.msg import OccupancyGrid
from std_msgs.msg import Bool
from visualization_msgs.msg import Marker, MarkerArray

import tf2_ros

# 4-connectivity for traversal through free space, 8-connectivity for detecting
# adjacency to unknown cells and for clustering frontier cells together.
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
N8 = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))


class BfsExplorer(Node):
    def __init__(self):
        super().__init__('bfs_explorer')

        # --- parameters -----------------------------------------------------
        self.declare_parameter('map_topic', 'map')
        self.declare_parameter('nav_action', 'navigate_to_pose')
        self.declare_parameter('global_frame', 'map')
        self.declare_parameter('robot_frame', 'base_link')
        # Occupancy >= this value (0..100) is treated as an obstacle.
        self.declare_parameter('occupied_thresh', 65)
        # Minimum cluster size (in cells) to be considered a real frontier.
        self.declare_parameter('min_frontier_cells', 8)
        # How often to (re)plan when idle, seconds.
        self.declare_parameter('plan_period', 1.0)
        # Abort a goal that takes longer than this (seconds) and blacklist it.
        self.declare_parameter('goal_timeout', 60.0)
        # Blacklist radius (m): skip frontiers within this of a failed one.
        self.declare_parameter('blacklist_radius', 0.5)
        # Consecutive empty plan cycles before declaring exploration complete.
        self.declare_parameter('done_after_empty_cycles', 5)
        # Map auto-save: where to write, how often (s; 0 disables periodic save).
        self.declare_parameter('map_save_path',
                               os.path.expanduser('~/maps/guide_mate_map'))
        self.declare_parameter('map_topic_full', '/turtlebot468/map')
        self.declare_parameter('autosave_period', 30.0)

        gp = self.get_parameter
        self.map_topic = gp('map_topic').value
        self.nav_action = gp('nav_action').value
        self.global_frame = gp('global_frame').value
        self.robot_frame = gp('robot_frame').value
        self.occ_thresh = int(gp('occupied_thresh').value)
        self.min_cells = int(gp('min_frontier_cells').value)
        self.plan_period = float(gp('plan_period').value)
        self.goal_timeout = float(gp('goal_timeout').value)
        self.blacklist_radius = float(gp('blacklist_radius').value)
        self.done_after = int(gp('done_after_empty_cycles').value)
        self.map_save_path = gp('map_save_path').value
        self.map_topic_full = gp('map_topic_full').value
        self.autosave_period = float(gp('autosave_period').value)

        # --- state ----------------------------------------------------------
        self.map_msg = None
        self.state = 'IDLE'            # IDLE | NAVIGATING | DONE
        self.goal_handle = None
        self.nav_start_time = None
        self.current_goal_xy = None
        self.blacklist = []           # list of (x, y) in map frame
        self.empty_cycles = 0
        self.goals_sent = 0
        self.goals_reached = 0
        self._save_lock = threading.Lock()

        # --- ROS interfaces -------------------------------------------------
        map_qos = QoSProfile(
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            reliability=QoSReliabilityPolicy.RELIABLE,
            history=QoSHistoryPolicy.KEEP_LAST,
            depth=1)
        self.create_subscription(OccupancyGrid, self.map_topic,
                                 self._map_cb, map_qos)
        # glass_guard publishes bumped spots here; blacklist them so we stop
        # choosing frontiers behind glass the lidar can't see.
        self.create_subscription(PointStamped, 'bump_points',
                                 self._bump_cb, 10)
        self.nav_client = ActionClient(self, NavigateToPose, self.nav_action)
        self.marker_pub = self.create_publisher(MarkerArray, 'frontier_markers', 1)
        done_qos = QoSProfile(durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
                              reliability=QoSReliabilityPolicy.RELIABLE,
                              history=QoSHistoryPolicy.KEEP_LAST, depth=1)
        self.done_pub = self.create_publisher(Bool, 'exploration_complete', done_qos)

        self.tf_buffer = tf2_ros.Buffer()
        self.tf_listener = tf2_ros.TransformListener(self.tf_buffer, self)

        self.create_timer(self.plan_period, self._tick)
        if self.autosave_period > 0:
            self.create_timer(self.autosave_period,
                              lambda: self.save_map(tag='autosave'))
        self.get_logger().info(
            f"BFS explorer up. map='{self.map_topic}' action='{self.nav_action}' "
            f"frames=({self.global_frame}->{self.robot_frame}). Waiting for map + Nav2...")

    # ------------------------------------------------------------------ map
    def _map_cb(self, msg):
        self.map_msg = msg

    def _bump_cb(self, msg):
        xy = (msg.point.x, msg.point.y)
        if not self._is_blacklisted(*xy):
            self.blacklist.append(xy)
            self.get_logger().warn(
                f"bump reported at ({xy[0]:.2f}, {xy[1]:.2f}) -> frontier blacklisted.")
            # if we're currently driving toward that spot, abandon it
            if (self.current_goal_xy and
                    math.hypot(xy[0] - self.current_goal_xy[0],
                               xy[1] - self.current_goal_xy[1]) < 1.0
                    and self.goal_handle is not None):
                self.goal_handle.cancel_goal_async()
                self.state = 'IDLE'

    # --------------------------------------------------------------- helpers
    def _robot_cell(self, info):
        """Return (cx, cy) of the robot in grid coords, or None if no TF yet."""
        try:
            tf = self.tf_buffer.lookup_transform(
                self.global_frame, self.robot_frame, rclpy.time.Time(),
                timeout=Duration(seconds=0.5))
        except tf2_ros.TransformException as e:
            self.get_logger().warn(f"TF {self.global_frame}->{self.robot_frame} "
                                   f"unavailable: {e}", throttle_duration_sec=5.0)
            return None
        wx = tf.transform.translation.x
        wy = tf.transform.translation.y
        cx = int((wx - info.origin.position.x) / info.resolution)
        cy = int((wy - info.origin.position.y) / info.resolution)
        return cx, cy

    def _cell_to_world(self, info, cx, cy):
        wx = info.origin.position.x + (cx + 0.5) * info.resolution
        wy = info.origin.position.y + (cy + 0.5) * info.resolution
        return wx, wy

    def _is_blacklisted(self, x, y):
        for bx, by in self.blacklist:
            if math.hypot(x - bx, y - by) < self.blacklist_radius:
                return True
        return False

    def _nearest_free(self, grid, h, w, cx, cy, max_r=15):
        """If the robot cell is not free (e.g. inflated/unknown), spiral out to
        the closest free cell so BFS has a valid seed."""
        def free(v):
            return 0 <= v < self.occ_thresh
        if 0 <= cx < w and 0 <= cy < h and free(grid[cy, cx]):
            return cx, cy
        for r in range(1, max_r + 1):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h and free(grid[ny, nx]):
                        return nx, ny
        return None

    # ------------------------------------------------------------- frontiers
    def _find_frontiers(self, grid, h, w, start):
        """BFS through free space from `start`; return frontier cells as a dict
        {(x, y): bfs_distance}. A frontier cell is a free cell with at least one
        unknown (-1) 8-neighbour."""
        sx, sy = start
        dist = np.full((h, w), -1, dtype=np.int32)
        frontier = {}
        q = deque()
        q.append((sx, sy))
        dist[sy, sx] = 0
        while q:
            x, y = q.popleft()
            d = dist[y, x]
            is_frontier = False
            for dx, dy in N8:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and grid[ny, nx] == -1:
                    is_frontier = True
                    break
            if is_frontier:
                frontier[(x, y)] = d
            for dx, dy in N4:
                nx, ny = x + dx, y + dy
                if (0 <= nx < w and 0 <= ny < h and dist[ny, nx] < 0
                        and 0 <= grid[ny, nx] < self.occ_thresh):
                    dist[ny, nx] = d + 1
                    q.append((nx, ny))
        return frontier

    def _cluster(self, frontier):
        """Group frontier cells into 8-connected clusters. Returns a list of
        (centroid_cell, size, min_bfs_distance)."""
        seen = set()
        clusters = []
        for cell in frontier:
            if cell in seen:
                continue
            comp = []
            dq = deque([cell])
            seen.add(cell)
            while dq:
                cx, cy = dq.popleft()
                comp.append((cx, cy))
                for dx, dy in N8:
                    n = (cx + dx, cy + dy)
                    if n in frontier and n not in seen:
                        seen.add(n)
                        dq.append(n)
            size = len(comp)
            mx = sum(c[0] for c in comp) / size
            my = sum(c[1] for c in comp) / size
            mind = min(frontier[c] for c in comp)
            clusters.append(((mx, my), size, mind))
        return clusters

    # -------------------------------------------------------------- planning
    def _tick(self):
        if self.state == 'NAVIGATING':
            if (self.nav_start_time is not None and
                    (self.get_clock().now() - self.nav_start_time)
                    > Duration(seconds=self.goal_timeout)):
                self.get_logger().warn("Goal timed out; cancelling and blacklisting.")
                if self.current_goal_xy:
                    self.blacklist.append(self.current_goal_xy)
                if self.goal_handle is not None:
                    self.goal_handle.cancel_goal_async()
                self.state = 'IDLE'
            return
        if self.state == 'DONE':
            return
        if self.map_msg is None:
            return
        if not self.nav_client.server_is_ready():
            self.get_logger().warn("Nav2 action server not ready yet...",
                                   throttle_duration_sec=5.0)
            return

        info = self.map_msg.info
        w, h = info.width, info.height
        grid = np.array(self.map_msg.data, dtype=np.int16).reshape(h, w)

        rc = self._robot_cell(info)
        if rc is None:
            return
        seed = self._nearest_free(grid, h, w, rc[0], rc[1])
        if seed is None:
            self.get_logger().warn("No free cell near robot; cannot seed BFS.",
                                   throttle_duration_sec=5.0)
            return

        frontier = self._find_frontiers(grid, h, w, seed)
        clusters = self._cluster(frontier)

        candidates = []
        for (mx, my), size, mind in clusters:
            if size < self.min_cells:
                continue
            wx, wy = self._cell_to_world(info, mx, my)
            if self._is_blacklisted(wx, wy):
                continue
            candidates.append((mind, size, wx, wy))

        # BFS manner: smallest BFS distance first; break ties by larger frontier.
        candidates.sort(key=lambda c: (c[0], -c[1]))
        self._publish_markers(candidates)

        # Progress snapshot (no per-goal babysitting needed -- this is the log).
        res = info.resolution
        known_area = int(np.sum((grid >= 0))) * res * res
        self.get_logger().info(
            f"progress: known~{known_area:.1f} m^2, {len(candidates)} frontiers left, "
            f"goals sent={self.goals_sent} reached={self.goals_reached}")

        if not candidates:
            self.empty_cycles += 1
            self.get_logger().info(
                f"No reachable frontiers ({self.empty_cycles}/{self.done_after}).")
            if self.empty_cycles >= self.done_after:
                self.get_logger().info(
                    "Exploration COMPLETE -- map fully explored. Saving final map.")
                self.save_map(tag='final')
                self.done_pub.publish(Bool(data=True))
                self.state = 'DONE'
            return

        self.empty_cycles = 0
        _, size, wx, wy = candidates[0]
        self._send_goal(wx, wy, size)

    def _send_goal(self, wx, wy, size):
        # Face the frontier from the robot's current position.
        yaw = 0.0
        try:
            tf = self.tf_buffer.lookup_transform(
                self.global_frame, self.robot_frame, rclpy.time.Time())
            yaw = math.atan2(wy - tf.transform.translation.y,
                             wx - tf.transform.translation.x)
        except tf2_ros.TransformException:
            pass

        goal = NavigateToPose.Goal()
        goal.pose.header.frame_id = self.global_frame
        goal.pose.header.stamp = self.get_clock().now().to_msg()
        goal.pose.pose.position.x = float(wx)
        goal.pose.pose.position.y = float(wy)
        goal.pose.pose.orientation.z = math.sin(yaw / 2.0)
        goal.pose.pose.orientation.w = math.cos(yaw / 2.0)

        self.current_goal_xy = (wx, wy)
        self.state = 'NAVIGATING'
        self.nav_start_time = self.get_clock().now()
        self.goals_sent += 1
        self.get_logger().info(
            f"-> frontier #{self.goals_sent} at ({wx:.2f}, {wy:.2f}), "
            f"{size} cells. Navigating.")
        self.nav_client.send_goal_async(goal).add_done_callback(self._goal_response)

    def _goal_response(self, future):
        gh = future.result()
        if not gh.accepted:
            self.get_logger().warn("Goal REJECTED by Nav2; blacklisting.")
            if self.current_goal_xy:
                self.blacklist.append(self.current_goal_xy)
            self.state = 'IDLE'
            return
        self.goal_handle = gh
        gh.get_result_async().add_done_callback(self._goal_result)

    def _goal_result(self, future):
        status = future.result().status
        # 4 == SUCCEEDED in action_msgs/GoalStatus
        if status == 4:
            self.goals_reached += 1
            self.get_logger().info("Reached frontier. Replanning.")
        else:
            self.get_logger().warn(f"Goal ended with status {status}; blacklisting.")
            if self.current_goal_xy:
                self.blacklist.append(self.current_goal_xy)
        self.goal_handle = None
        self.state = 'IDLE'

    # -------------------------------------------------------------- map saving
    def save_map(self, tag='autosave'):
        """Save the current map to disk via map_saver_cli (non-blocking)."""
        if self.map_msg is None:
            return

        def _worker():
            if not self._save_lock.acquire(blocking=False):
                return  # a save is already in progress
            try:
                os.makedirs(os.path.dirname(self.map_save_path), exist_ok=True)
                cmd = ['ros2', 'run', 'nav2_map_server', 'map_saver_cli',
                       '-f', self.map_save_path, '--ros-args',
                       '-r', f'map:={self.map_topic_full}',
                       '-p', 'save_map_timeout:=10.0']
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                if r.returncode == 0:
                    self.get_logger().info(
                        f"[{tag}] map saved -> {self.map_save_path}.pgm/.yaml")
                else:
                    self.get_logger().warn(
                        f"[{tag}] map_saver failed: {r.stderr.strip()[:200]}")
            except Exception as e:
                self.get_logger().warn(f"[{tag}] map save error: {e}")
            finally:
                self._save_lock.release()

        threading.Thread(target=_worker, daemon=True).start()

    # ----------------------------------------------------------- visualisation
    def _publish_markers(self, candidates):
        arr = MarkerArray()
        clear = Marker()
        clear.action = Marker.DELETEALL
        arr.markers.append(clear)
        for i, (_, size, wx, wy) in enumerate(candidates):
            m = Marker()
            m.header.frame_id = self.global_frame
            m.header.stamp = self.get_clock().now().to_msg()
            m.ns = 'frontiers'
            m.id = i
            m.type = Marker.SPHERE
            m.action = Marker.ADD
            m.pose.position = Point(x=float(wx), y=float(wy), z=0.1)
            m.pose.orientation.w = 1.0
            scale = min(0.6, 0.1 + size * 0.01)
            m.scale.x = m.scale.y = m.scale.z = scale
            # nearest candidate (index 0 after sort) highlighted green, rest blue
            m.color.r = 0.0
            m.color.g = 1.0 if i == 0 else 0.4
            m.color.b = 0.0 if i == 0 else 1.0
            m.color.a = 0.9
            arr.markers.append(m)
        self.marker_pub.publish(arr)


def main():
    rclpy.init()
    node = BfsExplorer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
