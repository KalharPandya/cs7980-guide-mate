# GuideMate headless TB4 sim launcher.
# Mirrors turtlebot4_gz.launch.py but runs Gazebo SERVER-ONLY (`gz sim -s`, no GUI):
# on WSL's latency-bound d3d12 render path the GUI render pass caps RTF, so dropping
# it should roughly double RTF for headless SLAM / nav testing.
# Reuses the STOCK turtlebot4_spawn.launch.py (robot, sensor bridges, nodes) unchanged.

import os
from pathlib import Path

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node


ARGUMENTS = [
    DeclareLaunchArgument('namespace', default_value='robot_1',
                          description='Robot namespace'),
    DeclareLaunchArgument('rviz', default_value='false',
                          choices=['true', 'false'], description='Start rviz.'),
    DeclareLaunchArgument('world', default_value='maze',
                          description='Simulation World'),
    DeclareLaunchArgument('model', default_value='standard',
                          choices=['standard', 'lite'],
                          description='Turtlebot4 Model'),
]
for pose_element in ['x', 'y', 'z', 'yaw']:
    ARGUMENTS.append(DeclareLaunchArgument(pose_element, default_value='0.0',
                     description=f'{pose_element} component of the robot pose.'))


def generate_launch_description():
    pkg_turtlebot4_gz_bringup = get_package_share_directory('turtlebot4_gz_bringup')
    pkg_irobot_create_gz_bringup = get_package_share_directory('irobot_create_gz_bringup')
    pkg_turtlebot4_description = get_package_share_directory('turtlebot4_description')
    pkg_irobot_create_description = get_package_share_directory('irobot_create_description')
    pkg_ros_gz_sim = get_package_share_directory('ros_gz_sim')

    gz_resource_path = SetEnvironmentVariable(
        name='GZ_SIM_RESOURCE_PATH',
        value=':'.join([
            os.path.join(pkg_turtlebot4_gz_bringup, 'worlds'),
            os.path.join(pkg_irobot_create_gz_bringup, 'worlds'),
            str(Path(pkg_turtlebot4_description).parent.resolve()),
            str(Path(pkg_irobot_create_description).parent.resolve())
        ])
    )

    gz_sim_launch = PathJoinSubstitution([pkg_ros_gz_sim, 'launch', 'gz_sim.launch.py'])

    # Headless Gazebo: -s = server only (no GUI), -r = run on start.
    gazebo = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([gz_sim_launch]),
        launch_arguments=[
            ('gz_args', [LaunchConfiguration('world'), '.sdf', ' -s', ' -r', ' -v 1'])
        ]
    )

    clock_bridge = Node(
        package='ros_gz_bridge', executable='parameter_bridge', name='clock_bridge',
        output='screen',
        arguments=['/clock' + '@rosgraph_msgs/msg/Clock' + '[gz.msgs.Clock'])

    robot_spawn = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([PathJoinSubstitution(
            [pkg_turtlebot4_gz_bringup, 'launch', 'turtlebot4_spawn.launch.py'])]),
        launch_arguments=[
            ('namespace', LaunchConfiguration('namespace')),
            ('rviz', LaunchConfiguration('rviz')),
            ('x', LaunchConfiguration('x')),
            ('y', LaunchConfiguration('y')),
            ('z', LaunchConfiguration('z')),
            ('yaw', LaunchConfiguration('yaw'))]
    )

    ld = LaunchDescription(ARGUMENTS)
    ld.add_action(gz_resource_path)
    ld.add_action(gazebo)
    ld.add_action(clock_bridge)
    ld.add_action(robot_spawn)
    return ld
