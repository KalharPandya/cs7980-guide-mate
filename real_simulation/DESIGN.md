# Two-Robot Relay Guide — Design

**Goal (single-case demo):** In one shared map split by a *logical* midline ("the wall"),
a user types a mission in a chat box — e.g. *"lead me from the kitchen to the bathroom"* —
and two robots relay the human across the wall:

```
robot_1 spawns kitchen side (zone A)      robot_2 spawns bathroom side (zone B)
        │                                          │
        ├─ leads human to the door (midline) ──────┤   handoff at the wall
        └─ STOPS (cannot cross)              robot_2 leads human → bathroom
```

This is deliberately **more** than the existing "dog agent" work (which only does timed
tricks/emotes on one robot, no navigation, no coordination). The genuinely new pieces are
**(1) two-robot sim bringup, (2) named-destination navigation, (3) a dispatcher that
sequences a hand-off.**

---

## 1. What we reuse vs. drop from the existing repo

The repo's `agent_service` + `guide_mate_bridge` + `guidemate_msgs` stack was built for a
different job (chat → LLM → *timed twist tricks* over AWS IoT). We **do not run it.** We keep
only the *ideas*, re-implemented locally and much smaller.

| Concept in the existing stack | Our decision |
|---|---|
| LLM turns NL into a command (tool-calling) | **Keep the idea**, shrink it: one LLM call that emits our mission JSON. |
| `Command`/`Ack` custom JSON schema, `cmd_id` tracking | **Drop.** Dispatcher→robot uses Nav2's `NavigateToPose` action directly — its result is the ack. |
| Per-command speed/angular/time caps (`choreography.py`) | **Drop as per-command fields.** Caps live once in Nav2 params (`max_vel_x`, etc.) as defaults. |
| AWS IoT Core MQTT transport + bridge | **Drop.** Everything is local ROS 2; dispatcher calls Nav2 in-graph. |
| Bedrock / DynamoDB / Knowledge Base (RAG) / Polly / Transcribe / admin panel | **Drop.** None needed for the demo. (RAG was only for answering FAQ questions — it never had anything to do with keeping the robot in bounds.) |
| Concierge SPA (voice, emote-sync, arsenal, map tab) | **Drop.** Replace with a bare chat box (text in, text out). |

**Plug-in seam (why the cloud "isn't needed but could return"):** the dispatcher's only
input is a mission object `{origin, destination}`. Whatever produces it — a local chat box,
a CLI, or a future cloud agent over MQTT — is swappable behind that one seam.

---

## 2. Architecture

```
┌─ Chat box (tiny web page: text field + reply area) ─┐
└───────────────────────┬─────────────────────────────┘
                        │  user text: "lead me from the kitchen to the bathroom"
                        ▼
┌─ Intent LLM (one constrained call) ─────────────────┐
│  system prompt: "You ONLY output mission JSON.       │
│   Known locations: kitchen, bathroom, ... .          │
│   Emit {origin, destination}. If unclear, ask."      │
│  output → { "origin": "kitchen",                     │
│             "destination": "bathroom" }              │
└───────────────────────┬─────────────────────────────┘
                        │  mission JSON  (the ONLY custom message we define)
                        ▼
┌─ Dispatcher (ROS 2 Python node) ────────────────────┐
│  • location registry:  name → (x, y, θ)  [maze_truth]│
│  • zone map:           robot_1↔zone A, robot_2↔zone B│
│  • handoff point:      door pose on the midline      │
│  • mission FSM (sequential, see §5)                  │
│  • two NavigateToPose action clients                 │
└──────┬────────────────────────────┬─────────────────┘
       │ /robot_1/navigate_to_pose   │ /robot_2/navigate_to_pose
       ▼                             ▼
   Nav2 stack (robot_1)          Nav2 stack (robot_2)   ← each: AMCL + Nav2, namespaced
       └──────────────┬──────────────┘
                      ▼
           Gazebo (gz sim) — one maze world, two robots, one shared map
```

**Caps / safety defaults** (set once, not per command): Nav2 `FollowPath` `max_vel_x` /
`max_speed_xy` (already 0.15 in the real stack's `nav2_glass.yaml` — mirror that). No
per-command velocity ever leaves the dispatcher; it only sends *poses*.

---

## 3. The (minimal) message design — our own version

We define **exactly one** message, chat/LLM → dispatcher:

```json
{ "origin": "kitchen", "destination": "bathroom", "mission_id": "m1" }
```

* `origin`, `destination` — names that must exist in the location registry.
* `mission_id` — optional, for logging / letting the chat box report status.

Everything below the dispatcher is the **standard Nav2 action** `nav2_msgs/action/NavigateToPose`:
* **goal** = a `PoseStamped` in `map`
* **feedback** = `distance_remaining` (drives a "…on my way" status if we want it)
* **result** = `SUCCEEDED` / `ABORTED`  ← this replaces Kalhar's custom `Ack`

So there is **no** `cmd_id`, no `Command`, no `Ack`, no caps-in-message. Nav2 already gives
us goal + progress + terminal result.

---

## 4. Location registry + zone map

Coordinates are read off the validated `maps/maze_truth.{pgm,yaml}` (world frame, map origin
`[-10.51, -10.51]`, res `0.05`). Pick points by eye in RViz / the map image.

```python
LOCATIONS = {
    "kitchen":   (x1, y1, th1),   # zone A
    "bathroom":  (x2, y2, th2),   # zone B
    "door_A":    (xdA, ydA, thA), # midline, zone-A side  (robot_1's stop point)
    "door_B":    (xdB, ydB, thB), # midline, zone-B side  (robot_2's receive point)
}
ZONES = {                          # which robot owns which side of the midline
    "robot_1": "A",
    "robot_2": "B",
}
LOCATION_ZONE = { "kitchen": "A", "bathroom": "B" }   # each named place's side
```

The **midline is purely logical**: nothing in any costmap blocks it. robot_1 stays on side A
*because the dispatcher never gives it a goal past the door*. (Upgrade path if we ever want
robot_1 to *physically* refuse to cross: a Nav2 keepout-zone mask on robot_1's global
costmap. Out of scope for the demo.)

---

## 5. Dispatcher FSM (sequential — this is the core)

**Why sequential (not both at once):** if we fire robot_1→door and robot_2→bathroom
simultaneously, robot_2 leads "the human" onward before the human has actually reached /
crossed the door. The hand-off is a *temporal ordering*: robot_2's leading leg must wait for
robot_1 to arrive **and** for the crossing to happen.

```
IDLE
  └─ on mission{origin, destination}:
        za = LOCATION_ZONE[origin];  zb = LOCATION_ZONE[destination]
        if za == zb:  → SINGLE_LEG (one robot leads the whole way; no handoff)
        else:         → LEG1

LEG1  (lead robot leads human to the wall)
  lead   = robot owning za            # e.g. robot_1
  follow = robot owning zb            # e.g. robot_2
  send   lead → NavigateToPose(door_<za>)      # e.g. door_A
  await  result
    SUCCEEDED → say "We've reached the door. Please step through — my colleague will meet you." → HANDOFF
    ABORTED   → FAIL

HANDOFF  (wait for the human to cross)
  # In sim there is no real human. Trigger LEG2 by ONE of:
  #   (a) a fixed short pause, or
  #   (b) a "ready" confirmation from the chat box / console.
  # Optional overlap: follow robot may pre-position to door_<zb> during LEG1 —
  # that does NOT break the handoff (it only gets it ready); only LEG2 must wait.
  on crossing-confirmed → LEG2

LEG2  (follow robot leads human to the destination)
  send   follow → NavigateToPose(destination)
  await  result
    SUCCEEDED → say "You've arrived." → DONE
    ABORTED   → FAIL

SINGLE_LEG
  robot owning za → NavigateToPose(destination); await → DONE / FAIL

DONE / FAIL: report to chat box; return to IDLE.
```

This generalizes past kitchen→bathroom: any (origin, destination) in **different** zones
triggers the relay; **same** zone is a single-robot trip. The demo just exercises the
different-zone path.

**Dispatcher is ON TOP of Nav2, not inside it.** Nav2 is a single-robot point-to-point
driver that knows nothing about the other robot, the wall, or named places. The dispatcher is
a plain-Python state machine holding two `NavigateToPose` action clients and calling them in
order. It never touches costmaps.

---

## 6. Two-robot sim bringup (the prerequisite — see §8 of HANDOFF.md)

The dispatcher can't be tested until two robots navigate independently in one world. Steps:

1. **Multi-spawn launch.** The stock TB4 launch spawns one robot. We need a launch that
   spawns `robot_1` and `robot_2` as two gz entities, each namespaced, at different initial
   poses (one per zone).
2. **Per-robot AMCL + Nav2.** Duplicate the existing `loc_start` / `nav_start` per namespace
   (`robot_1/…`, `robot_2/…`), each seeded at its own spawn pose (not both at origin).
3. **TF — a visualization-only decision (KEY insight).** The dispatcher sends each robot a
   goal as a `PoseStamped` with `frame_id: map`; each robot's own Nav2 transforms it using
   *its own* TF. So the **dispatcher is decoupled from the TF topology** — it works whether
   TF is global or per-robot-private. TF merging is needed *only for RViz*. Two paths:
   * **Strategy A — global `/tf`, prefixed frames** (the §8 ideal): drop the `/tf → tf`
     remap; make AMCL, Nav2, *and the sim's TF publishers* emit to global `/tf`. Frames
     already carry `robot_N/` prefixes so `map→robot_1/odom` / `map→robot_2/odom` don't
     collide, `map` shared. Cost: write our own namespaced loc/nav launches (the TB4 wrapper
     hardwires the remap) + redirect the sim's TF. More upfront.
   * **Strategy B — keep per-robot private `/tf`, merge only for RViz** *(CHOSEN)*: leave
     today's verified single-robot stack unchanged, run it twice; run a tiny relay
     republishing `robot_1/tf` + `robot_2/tf` → `/tf` just for RViz. Minimal risk — nothing
     that works today changes, and the demo logic is identical to A because the dispatcher
     doesn't care about TF merging.
   Build M1/M3 on **B**; A is an optional polish item.
4. **One shared map, two AMCLs.** Both localize against `maze_truth`; each publishes its own
   `map → robot_N/odom`.
5. **RViz config.** Map + per-robot RobotModel / LaserScan / Path / Goal. Save it.
6. **Perf gate (validate EARLY).** Single-robot headless+software RTF ≈ 0.77. Two robots +
   two Nav2 stacks + RViz will be heavier; confirm it stays usable before building the
   dispatcher. Software rendering stays **mandatory** (GPU path breaks lidar).

Dispatcher then targets `/robot_1/navigate_to_pose` and `/robot_2/navigate_to_pose`.

---

## 6b. M1 FINDING (2026-07-22): two robots in ONE gz server is blocked

First M1 bring-up attempt: the launch spawns both robots, sensors, bridges, and TF fine,
but **`robot_1`'s drive controllers never activate** (`robot_2`'s did). Root cause is not our
launch — it's the vendor stack:

- The create3 model embeds the **`gz_ros2_control` plugin** in its xacro
  (`irobot_create_description/urdf/create3.urdf.xacro:137`), which starts a
  `controller_manager` **inside the single gz-sim process**. Two robots ⇒ **two plugin
  instances in one process**, which is a known-fragile gz_ros2_control configuration.
- The create3 controller spawners (`irobot_create_control/launch/include/control.py`) then
  collide/race: log shows `robot_1.controller_manager: "diffdrive_controller already
  loaded"` → spawner FATAL, then both robots' later spawners hit
  `"Could not contact service .../controller_manager/list_controllers"` (30 s timeout).
  Net: one robot drives, the other is dead. `ros2 control` CLI isn't even installed —
  this workspace was only ever exercised single-robot.

**Decision — Strategy for M1: two ISOLATED single-robot sims (gz partitions), NOT one world.**
Reuse the fully-working single-robot stack twice, each in its own gz server isolated by
`GZ_PARTITION`, sharing **ROS_DOMAIN_ID=0** so the dispatcher sees both robots' action
servers. Each gz process has exactly ONE `gz_ros2_control` plugin ⇒ the conflict disappears.
- **`/clock`:** bridge each sim's clock to a per-robot topic and remap `/clock:=/robot_N/clock`
  for that robot's nodes (AMCL/Nav2), so each stack runs on its own sim clock (no dual-clock
  collision).
- **Tradeoff accepted:** the robots live in two *copies* of the maze, so they can't physically
  collide/see each other — but the relay demo never needs that. They only share the **`map`
  frame** (same `maze_truth`), which is all the dispatcher + RViz require.
- **Perf:** two full gz servers on WSL software-render is the main risk — validate RTF first.
- Superseded artifacts: `sim_two_robots.launch.py` / `sim_two_robots.sh` (one-world attempt)
  are kept for reference but not the path forward.

## 6c. M1 VALIDATION (2026-07-22, Option 1 = two gz partitions)

Confirmed on-box:
- **Both robots spawn in separate `GZ_PARTITION` servers, each with WORKING controllers.**
  `robot_1` and `robot_2` each report `Configured and activated diffdrive_controller` — the
  one-world controller_manager conflict is gone (each gz process has exactly one
  gz_ros2_control plugin).
- **Per-robot clock works.** Each sim bridges its gz clock to `/robot_N/clock`; `SetRemap`
  propagated to the whole stack (72 subscribers on `/robot_1/clock`). Global `/clock` has 0
  publishers → no dual-clock collision.
- **Clean graph:** both robots have independent `clock`, `scan` (correct per-robot lidar
  frames `robot_N/turtlebot4/rplidar_link/rplidar`), `cmd_vel`, `odom`, `sim_ground_truth_pose`.
- **`robot_1` localization (AMCL) activates** on its namespaced clock via
  `nav_bringup_ns.launch.py`.

Perf (the known risk, now measured):
- **RTF ≈ 0.265 with BOTH sims running** (vs 0.77 single-robot), sustained load ~60 on 16
  cores. Functional but ~¼ speed; goals take ~4× wall time. Two Nav2 stacks push it lower.
- Mitigations if needed (established in prior single-robot work): cut cliff/IR sensor rates,
  rplidar to 10 Hz, disable camera (vendor `.urdf.xacro` edits), or use the `lite` model.
  For a *recorded* demo, low RTF is acceptable (record + speed up playback).

**PERF WALL HIT (2026-07-22):** with 2 sims + `robot_1` Nav2 (standard model), load climbed
to ~88/16 cores, RTF collapsed, AMCL dropped scans ("queue full"), and **Nav2 could not
finish activating** (stuck "waiting on external lifecycle transitions"). No config error —
pure CPU starvation. Two full software-rendered gz servers + Nav2 is too heavy for THIS box.
Decision pending on perf path: (A) trim compute — `lite` model (drop OAK-D), lower sensor +
Nav2 costmap rates, raise lifecycle bond timeouts; (B) revisit ONE gz world (halve gz cost)
and fix the gz_ros2_control multi-instance controller conflict; (C) run the sim on a beefier
machine. Standard-model two-partition path is validated but not runnable here as-is.

Artifacts (Option 1): `sim_partition.launch.py` + `sim_r1.sh`/`sim_r2.sh` (per-robot
partitioned sim), `nav2/nav_bringup_ns.launch.py` + `nav2/nav_r1.sh`/`nav_r2.sh`
(per-robot loc+Nav2 on the namespaced clock), `nav2/tf_relay.py` (merge → `/tf` for RViz),
`nav2/localization_maze_r2.yaml` + `nav2/nav2_maze_r2.yaml` (robot_2 frames).

## 6d. DISPATCHER + HALF-TASK VALIDATED (2026-07-22)

`dispatcher.py` built and the **half task runs end-to-end**: robot_1 (single-robot config,
RTF ~0.77) was driven **kitchen → door and stopped at the logical wall** via the dispatcher's
`NavigateToPose` client. Ground truth: robot_1 reached (-0.42, 0.15) vs door target
(-0.40, 0.00) = **0.15 m error**. Mission reported SUCCEEDED and spoke the hand-over line.

Two bugs found + fixed along the way:
1. Dispatcher shadowed rclpy `Node._clients` (a list) with a dict → executor crash. Renamed
   to `_nav_clients`.
2. **Per-robot `/clock` remap froze the in-gz diffdrive controller** (it lives in the gz
   process, outside the launch's `SetRemap`, and subscribes to GLOBAL `/clock`, which had no
   publisher after the remap → `/robot_1/odom` stuck at t=0 → `odom→base_link` never
   published → broken TF tree → costmap wouldn't activate → goal rejected). **Fix: use global
   `/clock` and run ONE sim at a time** (which the sequential relay does anyway). Removed the
   clock remap from `sim_partition.launch.py` and `nav_bringup_ns.launch.py`.
   → Consequence: true *simultaneous* two-sim needs the clock solved differently (per-robot
   `ROS_DOMAIN_ID` + a bridge, or a beefier host) AND is perf-blocked here regardless. The
   **half-task / sequential relay is the runnable demo on this box.**

### Run recipe (half-task, one leg at a time; each in its own terminal)
```
# LEG 1 — robot_1 leads kitchen -> door, stops
bash real_simulation/sim_r1.sh                 # robot_1 sim @ kitchen (global /clock)
bash real_simulation/nav2/nav_r1.sh            # robot_1 localization + Nav2
python3 real_simulation/nav2/tf_relay.py       # (optional) merge tf -> /tf for RViz
rviz2 -d real_simulation/nav2/two_robot.rviz   # (optional) watch it
python3 real_simulation/dispatcher.py --origin kitchen --dest bathroom --only leg1

# LEG 2 — robot_2 leads door -> bathroom  (tear down leg1 first; one sim at a time)
bash real_simulation/sim_r2.sh                 # robot_2 sim @ door_B
bash real_simulation/nav2/nav_r2.sh
python3 real_simulation/dispatcher.py --origin kitchen --dest bathroom --only leg2
```
`--only full` runs the whole relay in one shot (needs both sims + nav = perf-heavy here).

### BOTH LEGS VALIDATED (2026-07-22)
- **LEG1** robot_1 kitchen→door, stop: GT error **0.15 m**, SUCCEEDED.
- **LEG2** robot_2 door→bathroom: GT error **0.25 m**, SUCCEEDED.
The full relay is proven end-to-end (each leg single-robot, sequential). **Perf answer:** a
single robot's stack activates + drives cleanly only when the box is idle (load ~<20); when
load was elevated (~38, residual churn) robot_2's AMCL activation **service call timed out**
(`change_state (timeout)`) and nav aborted. Retried on an idle box → clean. So compute
contention is the real constraint — confirming the simultaneous two-sim wall. Worth
re-testing simultaneous on the AWS high-end box (headless).

## 6e. CHAT → LLM → DISPATCHER FRONT-END (2026-07-22, VALIDATED)

The "type a mission" front-end is built and validated **live end-to-end**: typing
*"lead me from the kitchen to the bathroom"* in the chat box → parsed to
`{origin:kitchen, destination:bathroom}` → `POST /api/run` → dispatcher → Nav2 →
**robot_1 drove to the door and stopped; mission SUCCEEDED** (server returned `{ok:true}`).

Artifacts (in `real_simulation/`):
- `chat_intent.py` — intent parser. LLM-first (Anthropic Claude, `output_config.format`
  constrained to emit the mission JSON) with a **zero-dependency keyword fallback**, so the
  pipeline runs with no API key / no install. Validated across phrasings ("from X to Y",
  "go to the bathroom", reversed, unknown-place clarification).
- `chat_server.py` — stdlib `http.server` (no framework). Serves a minimal chat page;
  `POST /api/chat` → `parse_mission`; `POST /api/run` → subprocesses `dispatcher.py` (ROS
  sourced) with a Leg selector (leg1 / leg2 / full) for the sequential, one-robot-at-a-time demo.

Enable the real LLM path (optional; keyword fallback works without it):
`pip install anthropic && export ANTHROPIC_API_KEY=sk-...` (model via `GUIDEMATE_MODEL`,
default `claude-opus-4-8`). No Bedrock/RAG needed.

**Sim-startup flakiness note:** on this loaded WSL box the gz sim bring-up is intermittently
racy — `gz_ros2_control` occasionally stalls "Waiting for data on robot_description" and
Nav2 lifecycle activation can time out ("Waiting for service controller_server/get_state")
when load is high or stale processes accumulate. Fix each time: kill ALL ros/gz procs
(they accumulate — 40 leftovers seen once), wait for load < ~5, relaunch. A clean relaunch
comes up fine (that's how all the validated runs were obtained). This is environment
reliability, not a code defect — the AWS high-end box should avoid it.

### Full demo run recipe (ready to record)
```
# terminal 1: robot_1 sim @ kitchen       bash real_simulation/sim_r1.sh
# terminal 2: robot_1 localization+Nav2   bash real_simulation/nav2/nav_r1.sh
# terminal 3 (optional RViz visual):       python3 real_simulation/nav2/tf_relay.py &
#                                          rviz2 -d real_simulation/nav2/two_robot.rviz
# terminal 4: chat front-end               python3 real_simulation/chat_server.py
#   -> open http://127.0.0.1:8080, pick "Leg 1", type "lead me from the kitchen to the bathroom"
# For LEG 2: tear down, bring up robot_2 (sim_r2.sh + nav_r2.sh), pick "Leg 2" in the chat.
```

## 7. Build order (milestones)

1. **M1 — Two robots navigate independently.** Multi-spawn + 2×(AMCL+Nav2) + global `/tf` +
   RViz. Verify by sending each robot a manual `NavigateToPose` goal (extend `send_goal.py`).
   *Gate: perf acceptable.*
2. **M2 — Location registry + single-robot named nav.** `name → pose` off `maze_truth`; wrap
   goal-sending so "kitchen"/"bathroom"/"door_A" resolve to poses.
3. **M3 — Dispatcher FSM (no chat).** Feed it a hard-coded mission `{kitchen, bathroom}`;
   watch the full relay (LEG1 → handoff pause → LEG2). This is the demo's spine.
4. **M4 — Chat box + intent LLM.** Bare web page → one constrained LLM call → mission JSON →
   dispatcher. Swappable seam; the demo already works without it (M3).
5. **M5 — Polish + record.** Chat status messages, the "please cross" line, RViz recording.

---

## 8. Open questions / to decide later

- **Handoff trigger in sim:** fixed pause vs. explicit "ready" from the chat box. (Lean:
  a short pause + a chat line, so the demo runs unattended.)
- **Where the maze's kitchen/bathroom/door actually are:** pick real coordinates off
  `maze_truth` once M1 is up.
- **Intent LLM host:** Claude via the Anthropic API (simplest; one call, JSON out) — no need
  for Bedrock/Strands. Model choice finalized at M4.
- **Repo integration:** this currently lives in `real_simulation/`; decide later whether/how it
  lands in the capstone repo (separate dir from the existing `sim/`).
```
