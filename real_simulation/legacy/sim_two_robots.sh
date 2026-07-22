#!/usr/bin/env bash
# GuideMate — TWO-ROBOT headless sim launcher (M1). Run in a DEDICATED terminal:
#   bash ~/robotics/sim_two_robots.sh [world]
# Then, each in its OWN terminal (sim time resets to 0 on every relaunch):
#   bash ~/robotics/nav2/loc_start.sh      # robot_1 AMCL   (existing)
#   bash ~/robotics/nav2/loc_start_r2.sh   # robot_2 AMCL
#   bash ~/robotics/nav2/nav_start.sh      # robot_1 Nav2   (existing)
#   bash ~/robotics/nav2/nav_start_r2.sh   # robot_2 Nav2
#   python3 ~/robotics/nav2/tf_relay.py    # merge tf -> /tf for ONE RViz
set -u
WORLD="${1:-maze}"

set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0
# SOFTWARE rendering MANDATORY (GPU/d3d12 breaks gz lidar -> all range_min).
export LIBGL_ALWAYS_SOFTWARE=1
unset GALLIUM_DRIVER MESA_D3D12_DEFAULT_ADAPTER_NAME

pkill -9 -f "turtlebot4_gz_bringup" 2>/dev/null
pkill -9 -f "ros_gz_bridge"          2>/dev/null
pkill -9 -f "gz sim"                 2>/dev/null
sleep 2
rm -f /dev/shm/fastrtps_* /dev/shm/sem.fastrtps_* /dev/shm/*fastdds* 2>/dev/null

echo "[sim_two_robots] HEADLESS gz (world=$WORLD): robot_1 @(-7.5,7.5), robot_2 @(6.0,-2.0)"
exec ros2 launch ~/robotics/sim_two_robots.launch.py world:="$WORLD"
