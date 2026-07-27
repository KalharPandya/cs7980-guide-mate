#!/usr/bin/env bash
# GuideMate — AMCL localization for robot_2 against maze_truth. Namespaced robot_2.
# Start the two-robot sim FIRST (bash ~/robotics/sim_two_robots.sh), then run this.
# sim time resets to 0 on every sim relaunch, so (re)start this AFTER the sim.
set -u
set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0

MAP=~/robotics/maps/maze_truth.yaml
PARAMS=~/robotics/nav2/localization_maze_r2.yaml

# kill only robot_2's stale localization nodes from a prior run
pkill -9 -f "__ns:=/robot_2.*__node:=amcl"        2>/dev/null
pkill -9 -f "__ns:=/robot_2.*__node:=map_server"  2>/dev/null
sleep 1

echo "[loc_start_r2] AMCL (TB4 wrapper): map=$MAP ns=robot_2 use_sim_time=true"
exec ros2 launch turtlebot4_navigation localization.launch.py \
  namespace:=robot_2 \
  use_sim_time:=true \
  map:="$MAP" \
  params:="$PARAMS"
