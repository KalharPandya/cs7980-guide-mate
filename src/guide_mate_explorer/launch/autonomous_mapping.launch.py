"""Full self-driven mapping stack: depth->scan fusion + SLAM + Nav2 + explorer.

This LAUNCHES AUTONOMOUS MOTION: once Nav2 and the explorer are up the robot
will drive itself to frontiers. Make sure the area is clear before running.

Because SLAM (slam_fused.yaml) and the Nav2 costmaps (nav2_glass.yaml) are now
pointed at `scan_fused`, *something must publish it* -- otherwise SLAM subscribes
to a topic nobody fills and the map never updates. This launch therefore starts
the producers too:

    OAK-D camera_node  ->  depth_lidar_fusion (scan_fused)  ->  SLAM + Nav2

Start order is staggered with TimerActions so each stage has its inputs ready.

Usage:
  # camera brought up by this launch (default):
  ros2 launch guide_mate_explorer autonomous_mapping.launch.py namespace:=turtlebot468

  # camera already running (e.g. the manual USB2 bring-up in CLAUDE.md):
  ros2 launch guide_mate_explorer autonomous_mapping.launch.py \
      namespace:=turtlebot468 start_camera:=false
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (DeclareLaunchArgument, IncludeLaunchDescription,
                            TimerAction)
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    namespace = LaunchConfiguration('namespace')
    start_camera = LaunchConfiguration('start_camera')
    nav_share = get_package_share_directory('turtlebot4_navigation')
    pkg_share = get_package_share_directory('guide_mate_explorer')
    glass_params = os.path.join(pkg_share, 'config', 'nav2_glass.yaml')

    # --- producers for scan_fused -------------------------------------------
    # OAK-D depth camera. Mirrors the known-good USB2 bring-up from CLAUDE.md
    # (the camera boot-loops on USB3; i_usb_speed:=HIGH forces USB2). Optional:
    # set start_camera:=false if the camera is already up.
    camera = Node(
        package='depthai_ros_driver',
        executable='camera_node',
        name='oakd',
        namespace=namespace,
        output='screen',
        condition=IfCondition(start_camera),
        parameters=[{
            'camera.i_pipeline_type': 'RGBD',
            'camera.i_usb_speed': 'HIGH',      # USB2 -- camera boot-loops on USB3
            'camera.i_nn_type': 'none',
            'camera.i_enable_imu': False,
            'rgb.i_publish_topic': False,
            'rgb.i_enable_preview': False,
            'left.i_fps': 6.0,
            'right.i_fps': 6.0,
            'stereo.i_publish_topic': True,
            'stereo.i_align_depth': False,
            'stereo.i_resolution': '400',      # string per depthai configs
        }],
    )

    # depth_lidar_fusion: folds OAK depth into the lidar scan -> scan_fused.
    # Reuse the dedicated launch so the node's params stay single-sourced.
    fusion = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(pkg_share, 'launch', 'depth_lidar_fusion.launch.py')),
        launch_arguments={'namespace': namespace}.items())

    # --- SLAM on the depth-fused scan ---------------------------------------
    # SLAM on scan_fused so the glass the lidar can't see enters the SLAM map,
    # not just the runtime costmap.
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
        DeclareLaunchArgument('start_camera', default_value='true',
                              description='Start the OAK-D camera_node. Set '
                                          'false if the camera is already up.'),
        # Camera first; it needs a few seconds to enumerate on USB2 and stream.
        camera,
        # Fusion next -- publishes scan_fused (falls back to raw lidar until
        # depth is flowing, so SLAM gets scans even before the camera warms up).
        TimerAction(period=6.0, actions=[fusion]),
        # SLAM + Nav2 once scan_fused is being published.
        TimerAction(period=8.0, actions=[slam, nav2]),
        # glass_guard can start early; it just listens for bumps.
        TimerAction(period=14.0, actions=[glass_guard]),
        # Give SLAM + Nav2 time to come up and produce map -> odom before the
        # explorer starts requesting goals.
        TimerAction(period=22.0, actions=[explorer]),
    ])
