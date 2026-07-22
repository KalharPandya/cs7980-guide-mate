#!/usr/bin/env bash
# GuideMate SLAM launcher (slam_toolbox via turtlebot4_navigation, namespaced).
# Run in a DEDICATED terminal (persists) AFTER the sim is up:  bash ~/robotics/slam_start.sh
set -u
# ROS setup.bash isn't `set -u`-clean.
set +u
source /opt/ros/jazzy/setup.bash
set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0

echo "[slam_start] launching slam_toolbox (namespace=robot_1, sim time) ..."
exec ros2 launch turtlebot4_navigation slam.launch.py \
  namespace:=robot_1 use_sim_time:=true
