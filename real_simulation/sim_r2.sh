#!/usr/bin/env bash
# GuideMate — robot_2 sim in its OWN gz partition. Launch SECOND, in a dedicated
# terminal, AFTER sim_r1.sh. Does NOT kill gz (that would kill robot_1's sim).
# Pose: (6.0, -2.0, yaw pi).
set -u
WORLD="${1:-maze}"
set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0
export LIBGL_ALWAYS_SOFTWARE=1
unset GALLIUM_DRIVER MESA_D3D12_DEFAULT_ADAPTER_NAME
export GZ_PARTITION=robot_2           # isolate this gz server (separate from robot_1)

# robot_2 starts at the door (bathroom side) and leads to the bathroom (leg 2).
echo "[sim_r2] gz partition=robot_2, ns=robot_2 @door_B(0.4,0.0), global /clock"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec ros2 launch "$DIR/sim_partition.launch.py" \
  namespace:=robot_2 partition:=robot_2 world:="$WORLD" x:=0.4 y:=0.0 yaw:=-0.34
