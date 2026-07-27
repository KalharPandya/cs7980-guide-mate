#!/usr/bin/env bash
# GuideMate — Nav2 stack for robot_2, namespaced, against maze_truth.
# Requires the two-robot sim UP and robot_2 AMCL running (loc_start_r2.sh)
# so map->robot_2/odom exists.
set -u
set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0

PARAMS=~/robotics/nav2/nav2_maze_r2.yaml

# clean only robot_2's stale nav2 servers from a prior run
pkill -9 -f "__ns:=/robot_2.*controller_server" 2>/dev/null
pkill -9 -f "__ns:=/robot_2.*bt_navigator"      2>/dev/null
pkill -9 -f "__ns:=/robot_2.*planner_server"    2>/dev/null
sleep 1

echo "[nav_start_r2] Nav2 (TB4 wrapper, ns=robot_2, use_sim_time=true) params=$PARAMS"
exec ros2 launch turtlebot4_navigation nav2.launch.py \
  namespace:=robot_2 \
  use_sim_time:=true \
  params_file:="$PARAMS"
