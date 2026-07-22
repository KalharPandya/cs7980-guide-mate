#!/usr/bin/env bash
# GuideMate — RViz for the two-robot demo. Reads the GLOBAL /tf (so run tf_relay.py too).
# Fixed frame = map; shows the maze map + robot scan(s) + Nav2 path(s). Run in its own terminal:
#   bash real_simulation/rviz.sh
set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0
# If RViz shows a black window or crashes on WSL, uncomment the next line (software GL):
# export LIBGL_ALWAYS_SOFTWARE=1
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec rviz2 -d "$DIR/nav2/two_robot.rviz"
