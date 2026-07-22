#!/usr/bin/env bash
# GuideMate TB4 Gazebo sim launcher (WSL2 ROS2 Jazzy, NAT networking).
# Run in a DEDICATED terminal so the sim persists:  bash ~/robotics/sim_start.sh [world]
# worlds: maze (default) | depot | warehouse
set -u
WORLD="${1:-maze}"

# ROS setup.bash isn't `set -u`-clean (references AMENT_TRACE_SETUP_FILES etc.)
set +u
source /opt/ros/jazzy/setup.bash
set -u
# clear any stale DDS overrides left from past debugging (NAT default is correct)
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0
# Render backend selectable via RENDER env var: gpu(=d3d12) | zink | software.
#   d3d12    = fast (RTF ~0.07) BUT breaks GPU-rendered sensors (lidar all range_min) on WSL.
#   zink     = OpenGL-on-Vulkan; candidate for GPU speed WITH working offscreen sensors.
#   software = llvmpipe; slow (RTF ~0.015) but sensors known-good (step 1).
RENDER="${RENDER:-gpu}"
unset LIBGL_ALWAYS_SOFTWARE GALLIUM_DRIVER MESA_D3D12_DEFAULT_ADAPTER_NAME
case "$RENDER" in
  software) export LIBGL_ALWAYS_SOFTWARE=1 ;;
  zink)     export GALLIUM_DRIVER=zink; export __GLX_VENDOR_LIBRARY_NAME=mesa ;;
  gpu|d3d12) export GALLIUM_DRIVER=d3d12; export MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA ;;
esac
echo "[sim_start] RENDER=$RENDER"

# kill any previous sim and wipe stale shared-memory locks (WSL FastDDS quirk)
pkill -9 -f "turtlebot4_gz_bringup" 2>/dev/null
pkill -9 -f "ros_gz_bridge"          2>/dev/null
pkill -9 -f "gz sim"                 2>/dev/null
sleep 2
rm -f /dev/shm/fastrtps_* /dev/shm/sem.fastrtps_* /dev/shm/*fastdds* 2>/dev/null

echo "[sim_start] launching TB4 (world=$WORLD, namespace=robot_1) ..."
exec ros2 launch turtlebot4_gz_bringup turtlebot4_gz.launch.py \
  namespace:=robot_1 rviz:=false world:="$WORLD"
