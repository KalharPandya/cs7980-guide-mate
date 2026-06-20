"""Launch only the BFS frontier explorer (assumes SLAM + Nav2 are already up).

Usage:
  ros2 launch guide_mate_explorer explore.launch.py namespace:=turtlebot468
"""
import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    namespace = LaunchConfiguration('namespace')

    return LaunchDescription([
        DeclareLaunchArgument('namespace', default_value='turtlebot468',
                              description='Robot namespace (no leading slash).'),
        Node(
            package='guide_mate_explorer',
            executable='bfs_explorer',
            name='bfs_explorer',
            namespace=namespace,
            output='screen',
            # TransformListener subscribes to the global /tf; remap so a
            # namespaced node reads the robot's namespaced TF tree.
            remappings=[('/tf', 'tf'), ('/tf_static', 'tf_static')],
            parameters=[{
                'map_topic': 'map',
                'nav_action': 'navigate_to_pose',
                'global_frame': 'map',
                'robot_frame': 'base_link',
                'occupied_thresh': 65,
                'min_frontier_cells': 8,
                'plan_period': 1.0,
                'goal_timeout': 60.0,
                'blacklist_radius': 0.5,
                'done_after_empty_cycles': 5,
                'map_save_path': os.path.expanduser('~/maps/guide_mate_map'),
                'map_topic_full': '/turtlebot468/map',
                'autosave_period': 30.0,
            }],
        ),
    ])
