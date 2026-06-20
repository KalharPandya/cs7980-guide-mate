#!/usr/bin/env bash
# Launch RViz2 to view turtlebot468 live mapping, lidar, and OAK-D depth returns.
# TF on this robot is namespaced (/turtlebot468/tf), so we remap RViz's /tf and
# /tf_static into that namespace — otherwise RViz shows "No transform" for everything.
set -eo pipefail

source /opt/ros/humble/setup.bash
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp
export ROS_DOMAIN_ID=0
export ROS_DISCOVERY_SERVER="${ROS_DISCOVERY_SERVER:-10.247.204.21:11811}"
export ROS_SUPER_CLIENT=True
unset FASTRTPS_DEFAULT_PROFILES_FILE || true

CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/turtlebot468_mapping.rviz"

exec rviz2 -d "$CONFIG" --ros-args \
  -r /tf:=/turtlebot468/tf \
  -r /tf_static:=/turtlebot468/tf_static
