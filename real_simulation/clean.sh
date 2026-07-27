#!/usr/bin/env bash
# GuideMate — preflight cleanup. Kills ALL ros/gz/sim/nav/chat procs (they accumulate and
# make the flaky WSL sim bring-up worse), clears DDS shm, and waits for load to settle.
# Run this BEFORE bringing anything up:  bash real_simulation/clean.sh
pats="gz sim|ruby|parameter_bridge|robot_state|irobot_create|__ns:=/robot_|amcl|map_server|controller_server|planner_server|bt_navigator|behavior_server|smoother_server|velocity_smoother|collision_monitor|waypoint_follower|route_server|opennav_docking|lifecycle_manager|nav_bringup|sim_partition|hazards|pose_repub|mock_pub|chat_server|dispatcher.py|tf_relay|rviz2"
for i in 1 2; do
  pgrep -af "$pats" 2>/dev/null | grep -v pgrep | grep -v clean.sh | awk '{print $1}' | xargs -r kill -9 2>/dev/null
  sleep 2
done
rm -f /dev/shm/fastrtps_* /dev/shm/sem.fastrtps_* /dev/shm/*fastdds* 2>/dev/null
n=$(pgrep -af "gz sim|ruby|amcl|controller_server|rviz2" 2>/dev/null | grep -v pgrep | grep -v clean.sh | wc -l)
echo "[clean] remaining ros/gz procs: $n"
echo -n "[clean] waiting for load < 5 "
for i in $(seq 1 40); do
  l=$(awk '{print int($1)}' /proc/loadavg); [ "$l" -lt 5 ] && break; echo -n "."; sleep 3
done
echo " -> load: $(cat /proc/loadavg | cut -d' ' -f1)"
echo "[clean] ready. Bring up sim_r1.sh next."
