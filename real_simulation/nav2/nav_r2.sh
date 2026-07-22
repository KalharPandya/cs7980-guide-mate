#!/usr/bin/env bash
# GuideMate — robot_2 localization + Nav2 (partitioned two-robot demo, Option 1).
# Pure-ROS (no gz). Uses /robot_2/clock via the launch's SetRemap. Run AFTER
# sim_r2.sh, in its own terminal.
set -u
set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE FASTDDS_BUILTIN_TRANSPORTS
export ROS_DOMAIN_ID=0

pkill -9 -f "__ns:=/robot_2.*__node:=amcl"       2>/dev/null
pkill -9 -f "__ns:=/robot_2.*bt_navigator"       2>/dev/null
sleep 1

echo "[nav_r2] localization + Nav2 (ns=robot_2, clock=/robot_2/clock)"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec ros2 launch "$DIR/nav_bringup_ns.launch.py" \
  namespace:=robot_2 \
  map:=$DIR/../maps/maze_truth.yaml \
  loc_params:=$DIR/localization_maze_r2.yaml \
  nav_params:=$DIR/nav2_maze_r2.yaml
