# cs7980-guide-mate

CS7980 project — TurtleBot 4 guide robot that autonomously maps and navigates an indoor space.

This repo holds both the **documentation** (`docs/`) and the **ROS 2 code**
(`src/guide_mate_explorer/`). It is a colcon workspace — see [CLAUDE.md](CLAUDE.md) for
build/run/architecture and the hard-won gotchas.

## Code
- [`src/guide_mate_explorer`](src/guide_mate_explorer) — `bfs_explorer` (autonomous BFS
  frontier mapping) and `glass_guard` (bumper-based glass backstop).

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
- [OAK-D-LITE camera](docs/camera/oak-d-camera-test.md) — depth/RGB camera test:
  both streams work on USB 2, the USB 3 boot-loop root-caused to power, and the
  bandwidth-limited frame drops
