"""Full self-driven mapping stack: SLAM (slam_toolbox) + Nav2 + BFS explorer.

This LAUNCHES AUTONOMOUS MOTION: once Nav2 and the explorer are up the robot
will drive itself to frontiers. Make sure the area is clear before running.

Usage:
  ros2 launch guide_mate_explorer autonomous_mapping.launch.py namespace:=turtlebot468
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (DeclareLaunchArgument, IncludeLaunchDescription,
                            TimerAction)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    namespace = LaunchConfiguration('namespace')
    nav_share = get_package_share_directory('turtlebot4_navigation')
    pkg_share = get_package_share_directory('guide_mate_explorer')
    glass_params = os.path.join(pkg_share, 'config', 'nav2_glass.yaml')

    # SLAM on the depth-fused scan (scan_fused) so the glass the lidar can't see
    # enters the SLAM map, not just the runtime costmap.
    slam_params = os.path.join(pkg_share, 'config', 'slam_fused.yaml')
    slam = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(nav_share, 'launch', 'slam.launch.py')),
        launch_arguments={'namespace': namespace,
                          'params': slam_params}.items())

    # Nav2 with the glass-aware costmaps (adds a non-clearing bump obstacle layer).
    nav2 = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(nav_share, 'launch', 'nav2.launch.py')),
        launch_arguments={'namespace': namespace,
                          'params_file': glass_params}.items())

    glass_guard = Node(
        package='guide_mate_explorer',
        executable='glass_guard',
        name='glass_guard',
        namespace=namespace,
        output='screen',
        remappings=[('/tf', 'tf'), ('/tf_static', 'tf_static')],
        parameters=[{
            'hazard_topic': '/turtlebot468/_do_not_use/hazard_detection',
            'global_frame': 'map',
            'cloud_topic': 'bump_obstacles',
            'points_topic': 'bump_points',
            'reactive_backup': True,
            'cmd_vel_topic': '/turtlebot468/cmd_vel',
        }],
    )

    explorer = Node(
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
    )

    return LaunchDescription([
        DeclareLaunchArgument('namespace', default_value='turtlebot468',
                              description='Robot namespace (no leading slash).'),
        slam,
        nav2,
        # glass_guard can start early; it just listens for bumps.
        TimerAction(period=8.0, actions=[glass_guard]),
        # Give SLAM + Nav2 time to come up and produce map -> odom before the
        # explorer starts requesting goals.
        TimerAction(period=15.0, actions=[explorer]),
    ])
