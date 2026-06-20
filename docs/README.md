# cs7980 Guide-Mate — Documentation

Working documentation for the cs7980 TurtleBot 4 project.

## Index

### Network
- [Network overview](network/README.md) — how the robots are connected, addressing, discovery model
- [Connecting a TurtleBot 4 to NUwave](network/nuwave-connection.md) — step-by-step, including the 5 GHz fix that was the real blocker
- [ROS 2 over NUwave — what works and what doesn't](network/ros2-over-nuwave.md) — compatibility findings

### Camera
- [Camera overview](camera/README.md) — the OAK-D-LITE depth/RGB camera
- [OAK-D-LITE camera — test, findings, fixes, pending issues](camera/oak-d-camera-test.md) — both streams work on USB 2; USB 3 boot-loop root-caused to power; bandwidth-limited frame drops

### Mapping & navigation
- [Autonomous mapping — overview](mapping/README.md) — BFS frontier explorer + SLAM + Nav2, glass handling, how to run, status
- [Depth camera for mapping](mapping/depth-perception.md) — using the OAK-D depth to see glass the lidar can't: FOV, the height-filtered pipeline, compute, and the planned lidar-scan injection
- [Viewing live mapping in RViz](mapping/rviz-visualization.md) — laptop-side RViz for the map, lidar, depth scan and cloud; the tf-remap, QoS, and Lite-vs-Standard model gotchas
- Code: [`src/guide_mate_explorer`](../src/guide_mate_explorer) — the `bfs_explorer` and `glass_guard` nodes

### Power & battery
- [Power overview](power/README.md) — battery-powered robot; only `battery_state` metering; ~14 W idle
- [Power consumption & saving](power/power-saving.md) — measured draw, what's always running, and the working "park" (stop SLAM → lidar auto-idles + CPU freed); what does *not* work

---

## ⚠️ Security note
**Do not commit credentials to this repo.** NUwave usernames/passwords, robot passwords, and any private keys must stay out of version control. The docs use placeholders such as `<nuwave-username>` and `<nuwave-password>`. Keep real values in a local, untracked file (e.g. `secrets.local`, already gitignored) or a password manager.

## Quick facts
- **Robots:** two TurtleBot 4 units — `turtlebot468` (room 468) and `turtlebot436` (room 436).
- **Each robot = two computers:** a Raspberry Pi 4 (Ubuntu 22.04, ROS 2 Humble — the thing you SSH into) and an iRobot Create 3 base (joined to the Pi by USB-C, which is both power and a wired Ethernet link).
- **Discovery model:** FastDDS **Discovery Server** running on the Pi; the Create 3 stays off WiFi and talks to the Pi over the USB-C link.
- **Default fallback network:** a local ASUS router, SSID `ASUS_98` (the robots auto-connect to it).
