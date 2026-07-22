# GuideMate — per-robot localization + Nav2 for the partitioned two-robot demo.
# Wraps the stock TB4 wrappers (which add PushRosNamespace + /tf->tf remap) inside
# a group that also remaps /clock -> /<namespace>/clock, so this robot's AMCL/Nav2
# run on THEIR OWN sim's clock (matching sim_partition.launch.py). Everything stays
# on ROS_DOMAIN_ID=0 so one dispatcher + one RViz see all robots.
#
# Run one per robot (own terminal), AFTER that robot's sim is up:  nav_r1.sh / nav_r2.sh

import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (DeclareLaunchArgument, GroupAction,
                            IncludeLaunchDescription, TimerAction)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import SetRemap

ARGUMENTS = [
    DeclareLaunchArgument('namespace', default_value='robot_1'),
    DeclareLaunchArgument('map', default_value=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'maps', 'maze_truth.yaml')),
    DeclareLaunchArgument('loc_params'),
    DeclareLaunchArgument('nav_params'),
]


def generate_launch_description():
    pkg_nav = get_package_share_directory('turtlebot4_navigation')
    ns = LaunchConfiguration('namespace')

    localization = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            [PathJoinSubstitution([pkg_nav, 'launch', 'localization.launch.py'])]),
        launch_arguments=[
            ('namespace', ns),
            ('use_sim_time', 'true'),
            ('map', LaunchConfiguration('map')),
            ('params', LaunchConfiguration('loc_params')),
        ])

    # Nav2 a few seconds later so AMCL's map->odom TF exists before costmaps start.
    nav2 = TimerAction(period=6.0, actions=[
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                [PathJoinSubstitution([pkg_nav, 'launch', 'nav2.launch.py'])]),
            launch_arguments=[
                ('namespace', ns),
                ('use_sim_time', 'true'),
                ('params_file', LaunchConfiguration('nav_params')),
            ])])

    # Global /clock (one sim at a time for the sequential relay / half-task).
    group = GroupAction([
        localization,
        nav2,
    ])

    ld = LaunchDescription(ARGUMENTS)
    ld.add_action(group)
    return ld
