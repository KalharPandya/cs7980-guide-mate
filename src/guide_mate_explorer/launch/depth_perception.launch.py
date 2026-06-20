"""Depth perception pipeline for glass/low-obstacle detection.

Consumes the (already running) OAK-D depth stream and produces:
  - a 3D PointCloud2 (depth_image_proc::PointCloudXyzNode) for the costmap, and
  - a height-filtered LaserScan (pointcloud_to_laserscan) that collapses low
    obstacles like the glass-door metal base into a 2D scan for SLAM.

Standard packages only (depth_image_proc, pointcloud_to_laserscan).
Assumes camera_node is already up (see notes); run with:
  ros2 launch guide_mate_explorer depth_perception.launch.py namespace:=turtlebot468
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import ComposableNodeContainer, Node
from launch_ros.descriptions import ComposableNode


def generate_launch_description():
    ns = LaunchConfiguration('namespace')

    # OAK depth uses BEST_EFFORT sensor QoS; tell image_transport/subscribers to match.
    qos_override = {
        'qos_overrides./turtlebot468/oakd/stereo/image_raw.subscription.reliability':
            'best_effort',
    }

    pointcloud_container = ComposableNodeContainer(
        name='depth_pc_container',
        namespace=ns,
        package='rclcpp_components',
        executable='component_container',
        composable_node_descriptions=[
            ComposableNode(
                package='depth_image_proc',
                plugin='depth_image_proc::PointCloudXyzNode',
                name='point_cloud_xyz',
                namespace=ns,
                remappings=[
                    ('image_rect', 'oakd/stereo/image_raw'),
                    ('camera_info', 'oakd/stereo/camera_info'),
                    ('points', 'oakd/points'),
                ],
                parameters=[{'qos': 'sensor_data'}],
            ),
        ],
        output='screen',
    )

    pc_to_scan = Node(
        package='pointcloud_to_laserscan',
        executable='pointcloud_to_laserscan_node',
        name='depth_to_scan',
        namespace=ns,
        remappings=[
            ('cloud_in', 'oakd/points'),
            ('scan', 'oakd/scan'),
            ('/tf', 'tf'), ('/tf_static', 'tf_static'),
        ],
        parameters=[{
            'target_frame': 'base_link',
            'transform_tolerance': 0.1,
            # height band (in base_link): keep the metal base, drop the floor
            'min_height': 0.06,
            'max_height': 0.50,
            'angle_min': -1.2,
            'angle_max': 1.2,
            'angle_increment': 0.0087,
            'scan_time': 0.2,
            'range_min': 0.25,
            'range_max': 5.0,
            'use_inf': True,
        }],
    )

    return LaunchDescription([
        DeclareLaunchArgument('namespace', default_value='turtlebot468'),
        pointcloud_container,
        pc_to_scan,
    ])
