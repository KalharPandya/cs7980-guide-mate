"""Launch the combined single-process runner (glass_guard + bfs_explorer).

One process, one executor -> the per-node rclpy/DDS overhead is paid once. The
namespace + /tf remaps apply to every node inside the process. Each node still
reads its own declared parameter defaults; override with a node-name-keyed yaml
via params_file if needed.

  ros2 launch guide_mate_explorer combined.launch.py namespace:=turtlebot468
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    namespace = LaunchConfiguration('namespace')

    combined = Node(
        package='guide_mate_explorer',
        executable='guide_mate_bringup',
        namespace=namespace,
        output='screen',
        # Applies to ALL nodes in the process; namespaced TF for the listeners.
        remappings=[('/tf', 'tf'), ('/tf_static', 'tf_static')],
    )

    return LaunchDescription([
        DeclareLaunchArgument('namespace', default_value='turtlebot468',
                              description='Robot namespace (no leading slash).'),
        combined,
    ])
