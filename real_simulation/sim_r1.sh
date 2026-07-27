#!/usr/bin/env bash
# GuideMate — robot_1 sim in its OWN gz partition. Launch FIRST, in a dedicated
# terminal. Does a FULL reset (kills any prior gz/bridges).  Pose: (-7.5, 7.5).
set -u
WORLD="${1:-maze}"
set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0
export LIBGL_ALWAYS_SOFTWARE=1        # MANDATORY: GPU breaks gz lidar
unset GALLIUM_DRIVER MESA_D3D12_DEFAULT_ADAPTER_NAME
export GZ_PARTITION=robot_1           # isolate this gz server

# full reset (robot_1 is launched first)
pkill -9 -f "turtlebot4_gz_bringup" 2>/dev/null
pkill -9 -f "ros_gz_bridge"          2>/dev/null
pkill -9 -f "gz sim"                 2>/dev/null
sleep 2
rm -f /dev/shm/fastrtps_* /dev/shm/sem.fastrtps_* /dev/shm/*fastdds* 2>/dev/null

echo "[sim_r1] gz partition=robot_1, ns=robot_1 @kitchen(-3.16,3.0), clock=/robot_1/clock"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec ros2 launch "$DIR/sim_partition.launch.py" \
  namespace:=robot_1 partition:=robot_1 world:="$WORLD" x:=-3.16 y:=3.0 yaw:=0.0
