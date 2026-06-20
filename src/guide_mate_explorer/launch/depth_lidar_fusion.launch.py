"""Depth->lidar fusion: fold depth obstacles into the lidar scan.

Runs the depth_lidar_fusion node (assumes the OAK-D camera_node is already up --
see CLAUDE.md for the USB2 bring-up). Output: a fused scan on `scan_fused` that
is a drop-in for the raw lidar `scan`. Point slam_toolbox and the Nav2 costmaps
at `scan_fused` so the glass metal base also enters the SLAM map.

This is the alternative to depth_perception.launch.py: instead of a separate
`oakd/scan` costmap source, the depth is folded straight into the lidar scan.

  ros2 launch guide_mate_explorer depth_lidar_fusion.launch.py namespace:=turtlebot468
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    ns = LaunchConfiguration('namespace')

    fusion = Node(
        package='guide_mate_explorer',
        executable='depth_lidar_fusion',
        name='depth_lidar_fusion',
        namespace=ns,
        output='screen',
        # TransformListener subscribes to the global /tf; remap so a namespaced
        # node reads the robot's namespaced TF tree.
        remappings=[('/tf', 'tf'), ('/tf_static', 'tf_static')],
        parameters=[{
            'depth_image_topic': 'oakd/stereo/image_raw',
            'camera_info_topic': 'oakd/stereo/camera_info',
            'scan_in': 'scan',
            'scan_out': 'scan_fused',
            # height band (in the lidar/base plane): keep the metal base, drop floor
            'camera_height': 0.244,
            'min_height': 0.06,
            'max_height': 0.50,
            'range_min': 0.25,
            'range_max': 5.0,
        }],
    )

    return LaunchDescription([
        DeclareLaunchArgument('namespace', default_value='turtlebot468'),
        fusion,
    ])
