# cs7980 Guide-Mate — Documentation

Working documentation for the cs7980 TurtleBot 4 project.

## Index

### Network
- [Network overview](network/README.md) — how the robots are connected, addressing, discovery model
- [Connecting a TurtleBot 4 to NUwave](network/nuwave-connection.md) — step-by-step, including the 5 GHz fix that was the real blocker
- [ROS 2 over NUwave — what works and what doesn't](network/ros2-over-nuwave.md) — compatibility findings

### Camera
- [OAK-D-LITE camera — root cause, mode matrix, fixes](camera.md) — daily wedge root-caused to `usbfs_memory_mb=16` (fix: 256, not power); residual drop is the heavy-RGBD+USB3 current brownout (not CPU/temp); depth-only/USB2 is stable; bring-up + watchdog in [`scripts/`](../scripts/README.md)

### Mapping & navigation
- [Autonomous mapping — overview](mapping/README.md) — BFS frontier explorer + SLAM + Nav2, glass handling, how to run, status
- [Depth camera for mapping](mapping/depth-perception.md) — using the OAK-D depth to see glass the lidar can't: FOV, the height-filtered pipeline, compute, and the planned lidar-scan injection
- [Viewing live mapping in RViz](mapping/rviz-visualization.md) — laptop-side RViz for the map, lidar, depth scan and cloud; the tf-remap, QoS, and Lite-vs-Standard model gotchas
- [No-motion full-stack bring-up](mapping/bringup-no-motion.md) — run the whole stack on a docked robot that can't move (zeroed-velocity Nav2 params); the `auto_standby` lidar wake + the Claude-shell DDS-isolation gotcha
- Code: [`src/guide_mate_explorer`](../src/guide_mate_explorer) (Python) — `bfs_explorer`, `glass_guard`, `depth_lidar_fusion`, plus a combined `guide_mate_bringup` runner (glass_guard + bfs_explorer in one process); [`src/guide_mate_perception`](../src/guide_mate_perception) (C++, [README](../src/guide_mate_perception/README.md)) — rclcpp ports of **all three** nodes + a shared-TF container (~10–17× cheaper on the Pi 4)

### Power & battery
- [Power consumption & saving](power.md) — battery-powered robot; only `battery_state` metering; ~14 W idle; measured draw, what's always running, and the working "park" (stop SLAM → lidar auto-idles + CPU freed); what does *not* work

### AWS IoT Core (cloud connectivity)
- [AWS IoT Core overview](aws-iot/README.md) — what we set up on robot 468, where it could help, and the security note on keeping credentials out of the repo
- [What IoT Core is — building blocks](aws-iot/iot-core-overview.md) — things, certs/policies, the MQTT broker, shadows, rules, jobs, Greengrass; how our files map to each
- [IoT Core ↔ other AWS services + EC2 access](aws-iot/service-integration.md) — the Rules Engine, service-to-device, EventBridge, and the three ways EC2 can reach IoT Core
- [Secure Tunneling — remote SSH to a robot](aws-iot/secure-tunneling.md) — source/destination tokens, `localproxy`, the MQTT auto-delivery path, and why it isn't connected yet

---

## ⚠️ Security note
**Do not commit credentials to this repo.** NUwave usernames/passwords, robot passwords, and any private keys must stay out of version control. The docs use placeholders such as `<nuwave-username>` and `<nuwave-password>`; keep the real values in a local, gitignored file or a password manager.

## Quick facts
- **Robots:** two TurtleBot 4 units — `turtlebot468` (room 468) and `turtlebot436` (room 436).
- **Each robot = two computers:** a Raspberry Pi 4 (Ubuntu 22.04, ROS 2 Humble — the thing you SSH into) and an iRobot Create 3 base (joined to the Pi by USB-C, which is both power and a wired Ethernet link).
- **Discovery model:** FastDDS **Discovery Server** running on the Pi; the Create 3 stays off WiFi and talks to the Pi over the USB-C link.
- **Default fallback network:** a local ASUS router, SSID `ASUS_98` (the robots auto-connect to it).
