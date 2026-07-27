#!/usr/bin/env bash
# GuideMate — Nav2 navigation stack (planner/controller/bt/behaviors/smoother),
# namespaced robot_1, against maze_truth. Requires the sim UP and AMCL running
# (bash ~/robotics/nav2/loc_start.sh) so map->robot_1/odom exists.
set -u
set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0

PARAMS=~/robotics/nav2/nav2_maze.yaml

# clean stale nav2 servers from a prior run
pkill -9 -f "nav2.launch.py" 2>/dev/null
pkill -9 -f "controller_server" 2>/dev/null
pkill -9 -f "bt_navigator" 2>/dev/null
pkill -9 -f "planner_server" 2>/dev/null
sleep 1

echo "[nav_start] Nav2 (TB4 wrapper, ns=robot_1, use_sim_time=true) params=$PARAMS"
exec ros2 launch turtlebot4_navigation nav2.launch.py \
  namespace:=robot_1 \
  use_sim_time:=true \
  params_file:="$PARAMS"
