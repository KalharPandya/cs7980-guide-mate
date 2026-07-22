#!/usr/bin/env bash
# GuideMate TB4 sim launcher — HEADLESS (no Gazebo GUI) for faster RTF.
# Run in a DEDICATED terminal:  bash ~/robotics/sim_start_headless.sh [world]
set -u
WORLD="${1:-maze}"

# ROS setup.bash isn't `set -u`-clean (references AMENT_TRACE_SETUP_FILES etc.)
set +u
source /opt/ros/jazzy/setup.bash
set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0
# SOFTWARE rendering is MANDATORY: GPU (d3d12) breaks Gazebo sensors (lidar all range_min).
# See guidemate-sim-gpu-rendering-fix memory. Speed is reclaimed by headless + fewer sensors.
export LIBGL_ALWAYS_SOFTWARE=1
unset GALLIUM_DRIVER MESA_D3D12_DEFAULT_ADAPTER_NAME

pkill -9 -f "turtlebot4_gz_bringup" 2>/dev/null
pkill -9 -f "ros_gz_bridge"          2>/dev/null
pkill -9 -f "gz sim"                 2>/dev/null
sleep 2
rm -f /dev/shm/fastrtps_* /dev/shm/sem.fastrtps_* /dev/shm/*fastdds* 2>/dev/null

echo "[sim_start_headless] launching HEADLESS TB4 (world=$WORLD, namespace=robot_1) ..."
exec ros2 launch ~/robotics/sim_headless.launch.py \
  namespace:=robot_1 rviz:=false world:="$WORLD"
