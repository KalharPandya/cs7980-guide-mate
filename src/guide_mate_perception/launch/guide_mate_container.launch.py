"""Launch the C++ component container: depth_lidar_fusion + bfs_explorer +
glass_guard in ONE process sharing a SINGLE tf2 listener (the busy /tf stream is
parsed once, not three times; no Python GIL, so callbacks run multicore).

This starts autonomous MOTION once SLAM + Nav2 are up (bfs_explorer drives to
frontiers). Assumes the producer chain (camera -> depth_lidar_fusion is INSIDE
this container; SLAM + Nav2 must be started separately, e.g. via the explorer
package's autonomous stack pointed at scan_fused).

  ros2 launch guide_mate_perception guide_mate_container.launch.py namespace:=turtlebot468
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    ns = LaunchConfiguration('namespace')

    container = Node(
        package='guide_mate_perception',
        executable='guide_mate_container',
        namespace=ns,
        output='screen',
        # Applies to ALL nodes in the process incl. the single shared TF listener.
        remappings=[('/tf', 'tf'), ('/tf_static', 'tf_static')],
    )

    return LaunchDescription([
        DeclareLaunchArgument('namespace', default_value='turtlebot468'),
        container,
    ])
