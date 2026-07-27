# GuideMate — ONE robot in an ISOLATED gz partition (Option 1 of the two-robot demo).
# Each robot gets its OWN gz-sim server (GZ_PARTITION) so there is exactly ONE
# gz_ros2_control plugin per process -> no multi-instance controller_manager
# conflict (the one-world blocker, see DESIGN §6b). All robots share ROS_DOMAIN_ID=0
# so ONE dispatcher + ONE RViz see both.
#
# CLOCK: each partition's gz publishes its own sim time. We bridge it to
# /<namespace>/clock and SetRemap('/clock' -> '/<ns>/clock') for every node in
# this robot's stack, so robot_2 never consumes robot_1's clock (which would
# desync its sensor timestamps). The per-robot nav bringup applies the SAME remap.
#
# Launch two of these (different namespace + partition + pose), each in its own
# terminal, via sim_r1.sh / sim_r2.sh.

import os
from pathlib import Path

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (DeclareLaunchArgument, GroupAction,
                            IncludeLaunchDescription, SetEnvironmentVariable)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node, SetRemap

ARGUMENTS = [
    DeclareLaunchArgument('namespace', default_value='robot_1'),
    DeclareLaunchArgument('partition', default_value='robot_1',
                          description='GZ_PARTITION isolating this gz server'),
    DeclareLaunchArgument('world', default_value='maze'),
    DeclareLaunchArgument('model', default_value='standard', choices=['standard', 'lite']),
    DeclareLaunchArgument('x', default_value='0.0'),
    DeclareLaunchArgument('y', default_value='0.0'),
    DeclareLaunchArgument('yaw', default_value='0.0'),
]


def generate_launch_description():
    pkg_tb4_gz = get_package_share_directory('turtlebot4_gz_bringup')
    pkg_create_gz = get_package_share_directory('irobot_create_gz_bringup')
    pkg_tb4_desc = get_package_share_directory('turtlebot4_description')
    pkg_create_desc = get_package_share_directory('irobot_create_description')
    pkg_ros_gz = get_package_share_directory('ros_gz_sim')

    ns = LaunchConfiguration('namespace')

    set_partition = SetEnvironmentVariable('GZ_PARTITION', LaunchConfiguration('partition'))
    gz_resource_path = SetEnvironmentVariable(
        name='GZ_SIM_RESOURCE_PATH',
        value=':'.join([
            os.path.join(pkg_tb4_gz, 'worlds'),
            os.path.join(pkg_create_gz, 'worlds'),
            str(Path(pkg_tb4_desc).parent.resolve()),
            str(Path(pkg_create_desc).parent.resolve()),
        ]))

    gazebo = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            [PathJoinSubstitution([pkg_ros_gz, 'launch', 'gz_sim.launch.py'])]),
        launch_arguments=[
            ('gz_args', [LaunchConfiguration('world'), '.sdf', ' -s', ' -r', ' -v 1'])])

    # Bridge this partition's gz /clock -> global ROS /clock. NOTE: run ONE sim at a
    # time (the sequential relay / half-task) so there is a single /clock publisher.
    # The in-gz diffdrive controller subscribes to GLOBAL /clock, so we must NOT
    # namespace it here or the controller's clock freezes (odom stops -> broken TF).
    clock_bridge = Node(
        package='ros_gz_bridge', executable='parameter_bridge', name='clock_bridge',
        output='screen',
        arguments=['/clock@rosgraph_msgs/msg/Clock[gz.msgs.Clock'])

    robot = GroupAction([
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                [PathJoinSubstitution([pkg_tb4_gz, 'launch', 'turtlebot4_spawn.launch.py'])]),
            launch_arguments=[
                ('namespace', ns),
                ('rviz', 'false'),
                ('localization', 'false'),
                ('nav2', 'false'),
                ('slam', 'false'),
                ('x', LaunchConfiguration('x')),
                ('y', LaunchConfiguration('y')),
                ('z', '0.0'),
                ('yaw', LaunchConfiguration('yaw')),
            ]),
    ])

    ld = LaunchDescription(ARGUMENTS)
    ld.add_action(set_partition)
    ld.add_action(gz_resource_path)
    ld.add_action(gazebo)
    ld.add_action(clock_bridge)
    ld.add_action(robot)
    return ld
