#!/usr/bin/env bash
# GuideMate — Step A: AMCL localization against maze_truth, namespaced robot_1.
# Start the sim FIRST (bash ~/robotics/sim_start_headless.sh), then run this.
# sim time resets to 0 on every sim relaunch, so (re)start this AFTER the sim.
set -u
set +u
source /opt/ros/jazzy/setup.bash
set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0

MAP=~/robotics/maps/maze_truth.yaml
PARAMS=~/robotics/nav2/localization_maze.yaml

# kill any stale localization nodes from a prior run (orphaned lifecycle nodes)
pkill -9 -f "nav2_bringup/localization_launch" 2>/dev/null
pkill -9 -f "localization.launch.py"           2>/dev/null
pkill -9 -f "__node:=amcl"                      2>/dev/null
pkill -9 -f "__node:=map_server"               2>/dev/null
pkill -9 -f "lifecycle_manager_localization"   2>/dev/null
sleep 1

# Use the TB4 wrapper: it adds PushRosNamespace(namespace) so nodes land under
# /robot_1 and tf is remapped to /robot_1/tf. nav2_bringup's launch alone does
# NOT self-namespace its Node() actions (verified), so calling it directly puts
# amcl/map_server at root and AMCL never sees /robot_1/scan.
echo "[loc_start] AMCL localization (TB4 wrapper): map=$MAP ns=robot_1 use_sim_time=true"
exec ros2 launch turtlebot4_navigation localization.launch.py \
  namespace:=robot_1 \
  use_sim_time:=true \
  map:="$MAP" \
  params:="$PARAMS"
