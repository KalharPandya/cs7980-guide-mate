# guide_mate_perception (C++)

Faithful **`rclcpp` ports** of the three custom `guide_mate_explorer` Python nodes, plus a
**single-process shared-TF component container**. This is the answer to **Pi-4 compute
saturation**: running the full Python stack drives the Pi-4 to load ~18 (SLAM scan-queue
overflow, Nav2 lifecycle timeouts). The C++ nodes do the same work for **~10–17× less CPU**,
and the container pays the busy `/tf` deserialization cost **once** instead of per node.

> Run the **Python OR the C++** node for a given role — **not both** (they publish the same
> topics / offer the same actions). Same topics, params, frames, and numerics as the Python
> originals; drop-in replacements.

## What's here
| Executable | Ports the Python node | Notes |
|---|---|---|
| `depth_lidar_fusion` | `depth_lidar_fusion` | OAK-D depth → `scan_fused`. ~10× cheaper TF/image handling; mirrors numpy numerics (float32 decision path, round-half-even, median, argmin tie-break). CPU-bound → keeps its own core. |
| `bfs_explorer` | `bfs_explorer` | BFS frontier explorer. **Goal-level only** — sends one `NavigateToPose` goal, waits for the result, replans; **never publishes `cmd_vel`** (that's Nav2). Uses TF only to seed BFS from the robot cell + orient the goal. |
| `glass_guard` | `glass_guard` | Bump → persistent non-clearing costmap obstacle. `reactive_backup` defaults **false** (no `cmd_vel`). |
| `guide_mate_container` | — | **Shared-TF runner**: all three nodes in ONE process, ONE `tf2_ros::Buffer` + ONE `TransformListener`, on a `MultiThreadedExecutor`. |

Each node also builds as its own standalone executable (its `main()` is suppressed in the
container build via `#define GUIDE_MATE_CONTAINER`).

## Why a shared-TF container
On a namespaced robot, every node with a `tf2_ros::TransformListener` spins its own internal
node that **deserializes the full ~31 Hz `/tf` firehose**. Measured: an *idle* rclpy node
costs ~0% CPU, but each TF listener costs ~16% of a Pi-4 core just parsing `/tf`. Bundling
the **Python** nodes in one process did **not** help (the cost is per-listener, not
per-process). The fix is **one** listener feeding all nodes:

- one `tf2_ros::Buffer` is injected into every node → `/tf` parsed **once** (validated:
  `/turtlebot468/tf` Subscription count = **1**; the behavior nodes own **0** TF subs);
- C++ has **no GIL**, so the `MultiThreadedExecutor` runs their callbacks across cores.

## Benchmarks (Pi-4, identical synthetic load, isolated domain)
Steady-state %CPU of one core, C++ vs the Python original:

| Node | Python | C++ | Reduction |
|---|---:|---:|---:|
| `depth_lidar_fusion` (640×480 depth @6 Hz + scan @8 Hz + tf @31 Hz) | 52.4% | **3.7%** | ~14× |
| `bfs_explorer` (160k-cell map, plan @2 Hz + tf @31 Hz) | 95.8% | **5.7%** | ~17× |
| `glass_guard` (idle, tf @31 Hz parse only) | 17.8% | **1.8%** | ~10× |
| **aggregate** | **~166%** | **~11%** | **~15×** |

The shared-TF container idles at ~1.5% CPU for all three nodes + the TF node in one process.

## Run
```bash
source /opt/ros/humble/setup.bash && source ~/cs7980-guide-mate/install/setup.bash

# C++ fusion only (point SLAM + Nav2 at scan_fused):
ros2 launch guide_mate_perception depth_lidar_fusion_cpp.launch.py namespace:=turtlebot468

# All three in one shared-TF process (fusion + glass_guard + bfs_explorer).
# NOTE: starts autonomous MOTION once SLAM + Nav2 are up (bfs drives to frontiers).
ros2 launch guide_mate_perception guide_mate_container.launch.py namespace:=turtlebot468
```

Both launches remap `('/tf','tf'),('/tf_static','tf_static')` so the (single) listener reads
the robot's **namespaced** TF tree — without this, lookups fail silently (see the namespaced-TF
gotcha in [`../../CLAUDE.md`](../../CLAUDE.md)).

See [`docs/mapping/depth-perception.md`](../../docs/mapping/depth-perception.md) for the
fusion algorithm and [`docs/mapping/README.md`](../../docs/mapping/README.md) for the stack.
