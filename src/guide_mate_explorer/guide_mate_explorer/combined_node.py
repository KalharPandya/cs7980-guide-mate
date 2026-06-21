"""Single-process runner for the lightweight guide_mate nodes.

Runs ``GlassGuard`` + ``BfsExplorer`` in ONE process under a single executor, so
the per-node rclpy/FastDDS overhead (measured at ~16% of a Pi-4 core for an idle
Python node) is paid once instead of once-per-node. The node classes are
imported unchanged and remain individually runnable via their own ``ros2 run``
entry points -- this only ADDS a combined entry point, it does not replace them.

``depth_lidar_fusion`` is intentionally NOT included here: it is CPU-bound
(per-frame depth maths) and would serialize against the others on the Python
GIL, so it keeps its own process/core (and is the candidate to rewrite as a C++
rclcpp component for true multicore).

Run combined:
  ros2 run guide_mate_explorer guide_mate_bringup --ros-args \
    -r __ns:=/turtlebot468 -r /tf:=tf -r /tf_static:=tf_static
"""
import rclpy
from rclpy.executors import MultiThreadedExecutor

from guide_mate_explorer.glass_guard import GlassGuard
from guide_mate_explorer.bfs_explorer import BfsExplorer


def main():
    rclpy.init()
    # One executor, multiple nodes -> one spin loop + one DDS context for all.
    executor = MultiThreadedExecutor()
    nodes = [GlassGuard(), BfsExplorer()]
    for n in nodes:
        executor.add_node(n)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        for n in nodes:
            n.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
