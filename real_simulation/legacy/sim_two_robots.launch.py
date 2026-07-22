# GuideMate — TWO-ROBOT headless sim (M1 of the two-robot relay demo).
# Brings up gz sim + /clock ONCE, then spawns robot_1 and robot_2 at different
# poses in the SAME maze world. Each spawn is fully namespaced (stock
# turtlebot4_spawn.launch.py): gz entity = "<ns>/turtlebot4", bridges/nodes/TF
# under /<ns>, TF private on /<ns>/tf (the /tf->tf remap). Localization + Nav2
# are launched SEPARATELY per robot (Strategy B) via loc_start*/nav_start*.
#
# Spawn poses default to validated free cells (clearance 2.5 m / 2.0 m) on
# opposite sides of the logical midline x=0. Override with r1_x:=.. etc.
#
# Run via the wrapper:  bash ~/robotics/sim_two_robots.sh

import os
from pathlib import Path

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (DeclareLaunchArgument, IncludeLaunchDescription,
                            SetEnvironmentVariable, TimerAction)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node

ARGUMENTS = [
    DeclareLaunchArgument('world', default_value='maze', description='Simulation world'),
    DeclareLaunchArgument('model', default_value='standard', choices=['standard', 'lite']),
    # robot_1 spawn pose (left of midline x=0)
    DeclareLaunchArgument('r1_x', default_value='-7.5'),
    DeclareLaunchArgument('r1_y', default_value='7.5'),
    DeclareLaunchArgument('r1_yaw', default_value='0.0'),
    # robot_2 spawn pose (right of midline x=0)
    DeclareLaunchArgument('r2_x', default_value='6.0'),
    DeclareLaunchArgument('r2_y', default_value='-2.0'),
    DeclareLaunchArgument('r2_yaw', default_value='3.1416'),
]


def _spawn(namespace, x, y, yaw):
    pkg = get_package_share_directory('turtlebot4_gz_bringup')
    return IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            [PathJoinSubstitution([pkg, 'launch', 'turtlebot4_spawn.launch.py'])]),
        launch_arguments=[
            ('namespace', namespace),
            ('rviz', 'false'),
            ('localization', 'false'),   # run separately per robot (Strategy B)
            ('nav2', 'false'),
            ('slam', 'false'),
            ('x', x), ('y', y), ('z', '0.0'), ('yaw', yaw),
        ])


def generate_launch_description():
    pkg_tb4_gz = get_package_share_directory('turtlebot4_gz_bringup')
    pkg_create_gz = get_package_share_directory('irobot_create_gz_bringup')
    pkg_tb4_desc = get_package_share_directory('turtlebot4_description')
    pkg_create_desc = get_package_share_directory('irobot_create_description')
    pkg_ros_gz = get_package_share_directory('ros_gz_sim')

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

    clock_bridge = Node(
        package='ros_gz_bridge', executable='parameter_bridge', name='clock_bridge',
        output='screen',
        arguments=['/clock@rosgraph_msgs/msg/Clock[gz.msgs.Clock'])

    spawn_r1 = _spawn('robot_1', LaunchConfiguration('r1_x'),
                      LaunchConfiguration('r1_y'), LaunchConfiguration('r1_yaw'))
    # Stagger robot_2 so robot_1's entity + bridges settle first (avoids gz
    # create races and a bridge-startup thundering herd on WSL software render).
    spawn_r2 = TimerAction(period=10.0, actions=[
        _spawn('robot_2', LaunchConfiguration('r2_x'),
               LaunchConfiguration('r2_y'), LaunchConfiguration('r2_yaw'))])

    ld = LaunchDescription(ARGUMENTS)
    ld.add_action(gz_resource_path)
    ld.add_action(gazebo)
    ld.add_action(clock_bridge)
    ld.add_action(spawn_r1)
    ld.add_action(spawn_r2)
    return ld
