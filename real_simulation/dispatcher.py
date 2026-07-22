#!/usr/bin/env python3
"""GuideMate — two-robot relay DISPATCHER (mission FSM on top of Nav2).

Sits ABOVE Nav2: holds one NavigateToPose action client per robot and sequences
a hand-over across a LOGICAL midline (x=0). Nav2 does the per-robot point-to-point
driving; the dispatcher owns the mission logic (named locations, zone->robot,
sequencing). It never touches costmaps or cmd_vel.

Scenario: "lead me from the kitchen to the bathroom"
  LEG1  robot_1 (kitchen side) leads to the door (midline) and STOPS.
  HANDOFF  (human crosses; in sim = a pause / keypress)
  LEG2  robot_2 (bathroom side) leads from the door to the bathroom.

Because the relay is SEQUENTIAL, only ONE robot navigates at a time -> the
perf-friendly "half task" runs a single leg (`--only leg1` / `--only leg2`) in the
known-good single-robot sim config. `--only full` runs the whole relay (needs both
robots' nav; heavier).

Usage:
  python3 dispatcher.py --origin kitchen --dest bathroom --only leg1
  python3 dispatcher.py --origin kitchen --dest bathroom --only full --handoff-pause 4
"""
import sys, math, time, argparse
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import NavigateToPose

# --- Named destinations: name -> (x, y, yaw) in the map frame (from maze_truth) ---
LOCATIONS = {
    "kitchen":  (-3.16, 3.0, 0.0),
    "door_A":   (-0.4, 0.0, 0.0),   # robot_1 stop point, LEFT of midline x=0
    "door_B":   (0.4, 0.0, 0.0),    # robot_2 receive point, RIGHT of midline
    "bathroom": (6.0, -2.0, 0.0),
}
# Which robot owns which side of the midline, and each named place's side.
ROBOT_ZONE = {"robot_1": "A", "robot_2": "B"}   # A = left (x<0), B = right (x>0)
ZONE_ROBOT = {"A": "robot_1", "B": "robot_2"}
ZONE_DOOR  = {"A": "door_A", "B": "door_B"}
LOCATION_ZONE = {"kitchen": "A", "bathroom": "B", "door_A": "A", "door_B": "B"}

STATUS_SUCCEEDED = 4  # action_msgs/GoalStatus


class Dispatcher(Node):
    def __init__(self):
        super().__init__("guidemate_dispatcher")
        self._nav_clients = {}

    def _client(self, robot):
        if robot not in self._nav_clients:
            self._nav_clients[robot] = ActionClient(self, NavigateToPose, f"/{robot}/navigate_to_pose")
        return self._nav_clients[robot]

    def say(self, msg):
        # user-facing narration (the concierge voice line)
        print(f"\n\033[1m[dispatcher] {msg}\033[0m", flush=True)

    def drive(self, robot, loc_name, timeout_s=300.0):
        """Send robot to a named location; block until terminal. Returns True on SUCCEEDED."""
        x, y, yaw = LOCATIONS[loc_name]
        ac = self._client(robot)
        self.say(f"{robot} -> {loc_name} ({x:.2f}, {y:.2f})")
        if not ac.wait_for_server(timeout_sec=20.0):
            self.get_logger().error(f"{robot}: navigate_to_pose server not available"); return False

        goal = NavigateToPose.Goal()
        goal.pose.header.frame_id = "map"
        # leave stamp at 0 -> TF uses latest (dispatcher runs on wall time, Nav2 on sim time)
        goal.pose.pose.position.x = float(x)
        goal.pose.pose.position.y = float(y)
        goal.pose.pose.orientation.z = math.sin(yaw / 2.0)
        goal.pose.pose.orientation.w = math.cos(yaw / 2.0)

        fb = {"d": None}
        gf = ac.send_goal_async(goal, feedback_callback=lambda f: fb.__setitem__("d", f.feedback.distance_remaining))
        rclpy.spin_until_future_complete(self, gf)
        gh = gf.result()
        if not gh.accepted:
            self.get_logger().error(f"{robot}: goal to {loc_name} REJECTED"); return False

        rf = gh.get_result_async()
        t0 = time.monotonic(); last = 0.0
        while not rf.done():
            rclpy.spin_once(self, timeout_sec=0.1)
            if time.monotonic() - t0 > timeout_s:
                self.get_logger().error(f"{robot}: timeout to {loc_name}"); return False
            if fb["d"] is not None and time.monotonic() - last > 2.0:
                print(f"    {robot}  dist_remaining={fb['d']:.2f} m", flush=True); last = time.monotonic()

        status = rf.result().status
        ok = status == STATUS_SUCCEEDED
        self.say(f"{robot} {'ARRIVED at' if ok else 'FAILED (status %d) reaching' % status} {loc_name}")
        return ok

    # --- mission legs ---
    def leg1(self, origin):
        """Lead robot leads from origin to the door on its side, then STOPS at the wall."""
        za = LOCATION_ZONE[origin]
        lead = ZONE_ROBOT[za]
        self.say(f"MISSION leg 1: {lead} guides you from '{origin}' to the door.")
        # (origin is where the lead robot already is; go straight to the handoff door)
        if not self.drive(lead, ZONE_DOOR[za]):
            return False
        self.say("We've reached the door. Please step through — my colleague will meet you on the other side.")
        return True

    def leg2(self, destination):
        """Follow robot leads from its door to the destination."""
        zb = LOCATION_ZONE[destination]
        follow = ZONE_ROBOT[zb]
        self.say(f"MISSION leg 2: {follow} takes over and guides you to '{destination}'.")
        if not self.drive(follow, destination):
            return False
        self.say(f"You've arrived at the {destination}. Enjoy!")
        return True

    def run(self, origin, destination, only="full", handoff_pause=4.0):
        za, zb = LOCATION_ZONE[origin], LOCATION_ZONE[destination]
        if za == zb:
            # same side: single robot leads the whole way (no handoff)
            self.say(f"'{origin}' and '{destination}' are on the same side; {ZONE_ROBOT[za]} leads directly.")
            return self.drive(ZONE_ROBOT[za], destination)

        if only in ("leg1", "full"):
            if not self.leg1(origin):
                return False
        if only == "full":
            self.say(f"(handoff: waiting {handoff_pause:.0f}s for the human to cross the door)")
            t = time.monotonic()
            while time.monotonic() - t < handoff_pause:
                rclpy.spin_once(self, timeout_sec=0.1)
        if only in ("leg2", "full"):
            if not self.leg2(destination):
                return False
        self.say("Relay complete.")
        return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--origin", default="kitchen")
    ap.add_argument("--dest", default="bathroom")
    ap.add_argument("--only", choices=["leg1", "leg2", "full"], default="full",
                    help="leg1/leg2 = perf-friendly half task (one robot); full = whole relay")
    ap.add_argument("--handoff-pause", type=float, default=4.0)
    args = ap.parse_args()

    rclpy.init()
    d = Dispatcher()
    try:
        ok = d.run(args.origin, args.dest, only=args.only, handoff_pause=args.handoff_pause)
        print(f"\n=== mission {'SUCCEEDED' if ok else 'FAILED'} ===")
    finally:
        d.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
