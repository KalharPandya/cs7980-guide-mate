# cs7980-guide-mate

CS7980 project — TurtleBot 4 guide robot that autonomously maps and navigates an indoor space.

This repo holds both the **documentation** (`docs/`) and the **ROS 2 code** (two packages
under `src/`). It is a colcon workspace — see [CLAUDE.md](CLAUDE.md) for
build/run/architecture and the hard-won gotchas.

## Code
- [`src/guide_mate_explorer`](src/guide_mate_explorer) (Python) — `bfs_explorer`
  (autonomous BFS frontier mapping), `glass_guard` (bumper-based glass backstop), and
  `depth_lidar_fusion` (folds OAK-D-LITE depth into the lidar scan → `scan_fused`, so glass
  enters the SLAM map and the Nav2 costmap). A combined runner (`guide_mate_bringup` /
  `combined.launch.py`) runs `glass_guard` + `bfs_explorer` in one process under one
  executor to pay the rclpy/DDS overhead once.
- [`src/guide_mate_perception`](src/guide_mate_perception) (C++) — an rclcpp port of
  `depth_lidar_fusion` (~10× cheaper TF/image handling on the Pi-4, mirrors the Python
  numerics and output topic). Run the Python **or** the C++ fusion node, not both — this is
  the answer to Pi-4 compute saturation.

```bash
cd ~/cs7980-guide-mate && colcon build --symlink-install
source install/setup.bash
```

## Documentation

See [docs/README.md](docs/README.md) for the full index. Highlights:

- [Autonomous mapping](docs/mapping/README.md) — BFS explorer + SLAM + Nav2, glass handling,
  how to run
- [Depth camera for mapping](docs/mapping/depth-perception.md) — using OAK-D depth to see the
  glass the lidar can't (FOV, height-filtered pipeline, planned lidar-scan injection)
- [Network overview](docs/network/README.md) — two-computer architecture, discovery
  model, addressing, time sync
- [Connecting to NUwave](docs/network/nuwave-connection.md) — step-by-step, including
  the 5 GHz regulatory-domain fix
- [ROS 2 over NUwave](docs/network/ros2-over-nuwave.md) — what works / what doesn't,
  the four root causes, and the working laptop setup
- [OAK-D-LITE camera](docs/camera.md) — depth/RGB camera test:
  both streams work on USB 2, the USB 3 boot-loop root-caused to power, and the
  bandwidth-limited frame drops
- [Power](docs/power.md) — idle draw, why soft "park" services don't cut power, and the
  working park (kill the processes)
- [AWS IoT Core](docs/aws-iot/README.md) — thing/policy setup, service integration, and
  secure tunneling for remote access to robot 468
