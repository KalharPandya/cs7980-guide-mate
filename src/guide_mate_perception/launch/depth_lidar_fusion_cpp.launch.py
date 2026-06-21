"""Launch the C++ depth_lidar_fusion node (guide_mate_perception).

Faithful C++ port of the Python node, far cheaper on the Pi. Publishes to
`scan_out` (default scan_fused). Assumes the OAK-D camera_node is already up
(see CLAUDE.md USB2 bring-up). Namespaced TF needs the /tf remaps below.

  ros2 launch guide_mate_perception depth_lidar_fusion_cpp.launch.py namespace:=turtlebot468
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    ns = LaunchConfiguration('namespace')
    scan_out = LaunchConfiguration('scan_out')

    fusion = Node(
        package='guide_mate_perception',
        executable='depth_lidar_fusion',
        name='depth_lidar_fusion',
        namespace=ns,
        output='screen',
        remappings=[('/tf', 'tf'), ('/tf_static', 'tf_static')],
        parameters=[{
            'depth_image_topic': 'oakd/stereo/image_raw',
            'camera_info_topic': 'oakd/stereo/camera_info',
            'scan_in': 'scan',
            'scan_out': scan_out,
            'camera_height': 0.244,
            'min_height': 0.06,
            'max_height': 0.50,
            'range_min': 0.25,
            'range_max': 5.0,
        }],
    )

    return LaunchDescription([
        DeclareLaunchArgument('namespace', default_value='turtlebot468'),
        DeclareLaunchArgument('scan_out', default_value='scan_fused',
                              description='Output fused scan topic.'),
        fusion,
    ])
