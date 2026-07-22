#!/usr/bin/env bash
# GuideMate communication-sensitivity suite (Stages 0-4).
# Run AFTER the sim is up (sim needed for Stages 2-3; Stages 1&4 are sim-independent).
#   bash ~/robotics/diag/run_comm_suite.sh
set -u
set +u; source /opt/ros/jazzy/setup.bash; set -u
unset ROS_DISCOVERY_SERVER ROS_SUPER_CLIENT FASTRTPS_DEFAULT_PROFILES_FILE \
      ROS_AUTOMATIC_DISCOVERY_RANGE
export ROS_DOMAIN_ID=0
D=~/robotics/diag
hr(){ printf '%s\n' "------------------------------------------------------------"; }

echo "############ STAGE 0 — transport baseline ############"
echo "RMW: ${RMW_IMPLEMENTATION:-rmw_fastrtps_cpp (default)}"
echo -n "/dev/shm: "; df -h /dev/shm | tail -1
echo "stale fastrtps SHM segments: $(ls /dev/shm/ 2>/dev/null | grep -c fastrtps)"
echo "discovery stability (node count over 3 reads, should be stable & non-empty):"
for i in 1 2 3; do echo -n "  read $i: "; timeout 8 ros2 node list 2>/dev/null | grep -c . ; done
hr

echo "############ STAGE 1 — isolated DDS loopback (current transport) ############"
for qos in best_effort reliable; do
  for rate in 10 50 200; do
    for size in 0 8192; do
      timeout 20 python3 $D/comm_loopback.py --rate $rate --size $size --qos $qos --secs 6
    done
  done
done
hr

echo "############ STAGE 2 — command path fidelity (needs sim) ############"
timeout 60 python3 $D/comm_cmdpath.py --speed 0.3 --secs 20
hr

echo "############ STAGE 3 — sensor inflow (needs sim) ############"
timeout 25 python3 $D/comm_probe.py --topic /robot_1/scan --type scan --expect 10 --secs 10
timeout 25 python3 $D/comm_probe.py --topic /robot_1/odom --type odom --expect 30 --secs 10
timeout 25 python3 $D/comm_probe.py --topic /robot_1/tf   --type tf   --expect 0  --secs 10
timeout 20 python3 $D/comm_probe.py --topic /clock        --type clock --expect 0 --secs 8
hr

echo "############ STAGE 4 — transport variant comparison (loopback) ############"
echo "(sim-independent; isolates the DDS transport. Sim-topic comparison would need a relaunch per variant.)"
for tp in default UDPv4 SHM; do
  echo "=== transport: $tp ==="
  if [ "$tp" = "default" ]; then unset FASTDDS_BUILTIN_TRANSPORTS; else export FASTDDS_BUILTIN_TRANSPORTS=$tp; fi
  # focus on the load points that stress transport: high rate small, and large payload
  timeout 20 python3 $D/comm_loopback.py --rate 200 --size 0    --qos best_effort --secs 6
  timeout 20 python3 $D/comm_loopback.py --rate 50  --size 8192 --qos best_effort --secs 6
done
unset FASTDDS_BUILTIN_TRANSPORTS
hr
echo "suite complete."
