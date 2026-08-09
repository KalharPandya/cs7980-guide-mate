# Section III context: Robot Behaviour Prototype System

Ground truth for the prototype section of the paper. Everything below was read out of the
code on branch `feat/kalhar-elevenlabs-voice` (2026-08-05), not from the existing draft or
from memory. Every claim carries a `file:line`. Where a number exists only in prose docs and
not in code or a captured artifact, it is marked **DOC-ONLY** so you can decide whether to
cite it and how to hedge it.

Figure to paste: `Research/prototype-architecture-figure.tex`. It is compile-verified against
the paper's own IEEEtran preamble, 0 overfull boxes, ~170 mm wide inside a 181.9 mm text width.

---

## 0. The five things to fix in the current draft

Ordered by how wrong they are.

1. **"a spoken emote (a wiggle, nod or shake)"** is wrong. Emotes are not speech. They are
   physical twist sequences published on `cmd_vel`: `happy` is a body wiggle, `yes` a forward
   nod, `no` a rotational shake (`shared/guidemate_msgs/guidemate_msgs/choreography.py:54-80`).
   The parenthetical "wiggle, nod or shake" is exactly right; the word "spoken" is not.
2. **"one-tenth the cost of the Python original"** understates your own measurement. The repo
   reports the fusion node at 52.4% of a Pi-4 core in Python against 3.7% in C++, which is
   ~14x (`src/guide_mate_perception/README.md:40`). The ~10x row is `glass_guard`
   (17.8% to 1.8%, `README.md:42`).
3. **"Amazon Polly and Transcribe as fallbacks"** is half wrong. Transcribe streaming is the
   **default** STT, not a fallback (`agent_service/guidemate_agent/config.py:35`, `:63`).
   Polly genuinely is the TTS fallback (`speech.py:76-82`). Worse, the ElevenLabs STT path has
   **no runtime fallback at all**: a connect or consume failure returns an empty transcript and
   the turn silently no-ops (`speech.py:209-211`, `:219-221`, `:227-229`, consumed at
   `ws_chat.py:278`).
4. **"a per-tick dock guard"** conflates two mechanisms. The dock guard runs **once per
   command** (`bridge.py:47-57`, called at `:350-356`). What runs per tick is the abort check
   inside the drive loop (`executor.py:93-102`). Both are worth stating; they are not the same
   thing.
5. **"an unarmed session runs dry-run and is never even offered a motion tool"** merges two
   independent gates that live on different machines. Tool withholding is decided in the cloud
   by whether the session holds the **robot lock** (`dog_agent.py:411-413`, `:128-149`).
   Dry-run is a **robot-side** property, the OR of an environment flag and the device shadow
   (`safety.py:29-31`). A session can hold the lock and still be refused by the robot, and that
   is the normal resting state.

There is also one substantive finding that belongs to Sec. VI rather than Sec. III; see
section 10 below. It contradicts a claim currently made in the security section.

---

## 1. What the prototype actually is

A single TurtleBot 4 (`turtlebot468`) in one corridor of Northeastern's Vancouver campus,
docked between runs, human-observed, under a default-deny motion policy. A second unit
(`turtlebot436`) is provisioned but unused for this work. Every topic, transform and action is
namespaced under the robot's identity.

Three separable subsystems, built and exercised independently:

| Subsystem | Where it runs | What it does | Reachable from Moses? |
|---|---|---|---|
| A. Perception and navigation | Pi 4, ROS 2 Humble | lidar + depth fusion, SLAM, Nav2 | **No.** Separate bring-up |
| B. Moses cloud service | EC2, us-west-2 | conversation, retrieval, voice, dispatch | n/a, it is Moses |
| C. On-robot bridge | Pi 4, systemd unit | turns cloud commands into actuation | Yes, this is the only actuation path |

The single most important structural fact for the paper: **A and C are not connected.** The
deployed language front end commands timed primitives through C. It cannot issue a navigation
goal, and nothing in B or C ever talks to Nav2. The guide-to-room behaviour that resolves named
destinations is the simulation work in Sec. IV. The figure encodes this with dashed boxes.

---

## 2. Platform and hardware

All verified in repo docs; the two rows marked need a re-check before publication.

| Fact | Value | Source |
|---|---|---|
| Compute | Raspberry Pi 4, Ubuntu 22.04, ROS 2 Humble | `docs/README.md:44`, `docs/camera.md:4` |
| Base | iRobot Create 3, USB-C carries power and a wired ethernet link, `192.168.186.0/24` | `docs/network/README.md:15,17,55` |
| Middleware | FastDDS Discovery Server on the Pi, `ROS_DOMAIN_ID=0`, `rmw_fastrtps_cpp` | `CLAUDE.md:32-33` |
| Model | TurtleBot 4 **Lite** (the robot mis-advertises the Standard URDF) | `docs/mapping/rviz-visualization.md:64-68` |
| Lidar | RPLIDAR, 360 deg, ~8 Hz, single plane at ~0.19 m, blind to glass. `rplidar_link` is yawed ~90 deg from robot-forward | `docs/mapping/README.md:19,69`, `CLAUDE.md:80` |
| Depth camera | OAK-D-LITE, `depthai_ros_driver` 2.29.0, depth 16UC1 mm at **640x480**, HFOV ~73 deg, VFOV ~58 deg, mounted level at **0.244 m** | `docs/mapping/depth-perception.md:31-51` |
| Power | ~14 W idle undocked, ~12.2 W fully parked, idle endurance ~2.0 to ~2.3 h | `docs/power.md:18,104` |
| Create 3 firmware | H.2.6 | `CLAUDE.md:76` only, **not in `docs/`**. Re-verify on the robot or cite as an internal note |
| Lidar rate | ~8 Hz nominal, one measured SLAM run logged 6.8 Hz | `docs/power.md:65` and `CLAUDE.md:142`. Do not present 6.8 as the spec |

Two known hardware failure modes worth a sentence each, because both were misdiagnosed first
and that is itself a finding for the LLM-assisted-development argument:

- **OAK-D USB wedge.** Root cause is the kernel `usbfs_memory_mb=16` default, fixed by 256. It
  was previously and wrongly attributed to power; `vcgencmd get_throttled` stays `0x0`
  (`docs/camera.md:11-19`).
- **Residual depth drop.** Only in heavy RGB+depth on USB3, ~30 s MTTD, a 5 V rail brownout,
  not CPU and not temperature; a mode matrix plus load sweep ruled both out
  (`docs/camera.md:39-54,74-83`). Mitigation is to run depth-only, which mapping does anyway.

---

## 3. Subsystem A: perception and navigation

### 3.1 Node and topic graph

```
scan (LaserScan, ~8 Hz) ─┐
oakd/stereo/image_raw ───┼─> depth_lidar_fusion ─> scan_fused ─┬─> slam_toolbox ─> map, map->odom
oakd/stereo/camera_info ─┘                                     └─> Nav2 local + global costmaps
_do_not_use/hazard_detection ─> glass_guard ─┬─> bump_obstacles ─> Nav2 bump layer (non-clearing)
                                             └─> bump_points ───> bfs_explorer (blacklist)
map ─> bfs_explorer ─[NavigateToPose]─> Nav2 ─> cmd_vel ─> Create 3 base
```

Everything is relative-named under the `turtlebot468` namespace, so `scan` resolves to
`/turtlebot468/scan`. Three exceptions use hard-coded absolute defaults: `glass_guard`'s
hazard topic (`glass_guard.py:44-45`), its `cmd_vel` (`:58`), and the bridge's `cmd_vel`
(`bridge.py:255-256`).

**Namespaced TF gotcha worth one sentence in the paper:** `tf2_ros.TransformListener`
subscribes to the *global* `/tf`, so a namespaced node must remap `('/tf','tf')` and
`('/tf_static','tf_static')` or every lookup fails silently with `LookupException`
(`CLAUDE.md:73-75`, applied at `launch/depth_lidar_fusion.launch.py:30`).

### 3.2 depth_lidar_fusion, the one novel node

Source: `src/guide_mate_explorer/guide_mate_explorer/depth_lidar_fusion.py`. Output topic
`scan_fused`, BEST_EFFORT QoS (`:50`, `:168`).

Algorithm in order (`_depth_cb`, `:381-438`):

1. One-time static TF lookup `scan_frame <- optical_frame`, cached as a 3x3 rotation plus
   translation. Working in x/y rather than bearing is what accounts for the ~2 cm lidar to
   camera offset (`:350-379`, rationale `:17-19`).
2. Decode 16UC1 millimetres to metres, honouring endianness (`:390-393`).
3. Fit the ground plane for this frame (below).
4. Per-pixel height above the fitted floor, `height = (A + (B - v) * z) / fy` (`:399`).
5. Mask valid, positive-obstacle and, if `drop_detection`, below-floor returns (`:400-405`).
6. Vertical collapse: nearest kept pixel per column via min/argmin (`:410-416`).
7. Append drop edges (`:419-424`).
8. Back-project, rotate into the lidar frame, store range and bearing (`:430-438`).
9. On each scan: bin depth onto the beam grid with `np.minimum.at`, then
   `take = dmin < (lid - lidar_trust_margin)` (`:441-462`). **Injection only ever lowers a beam
   or fills an empty one. It never raises one.** That is the safety property worth stating.

**Self-calibrating ground plane** (`:236-287`). Fits `v = A/z + B` where `A = camera_height * fy`
and `B ~= cy`, from per-row median inverse depth, using least squares plus two rounds of 3-sigma
MAD rejection. Accepted only if enough inlier rows **and** `ground_h_lo * fy < A < ground_h_hi * fy`
(`:262-263`), EMA-smoothed, coasting on the last good fit for up to `ground_fail_max` frames
before falling back to the assumed model.

**Drop and negative obstacle flagging** is two layers (`:404`, `:289-339`): below-floor returns
treated like positives, plus a missing-floor edge check that walks each column far-ward along the
expected floor and flags the last present floor row as the near edge of a ledge. The rationale is
that with a level camera a real drop returns *nothing* rather than a below-plane point
(`docs/mapping/depth-perception.md:228-234`).

**Graceful degradation.** Three conditions return raw lidar passthrough unchanged: no cached
depth, depth older than `max_depth_age` (0.4 s), or no depth point inside the scan window
(`:466-476`, `:445-462`).

**camera_info guard.** The driver publishes 1280x720 `K` for a 640x480 depth image. Intrinsics
are taken from `camera_info` **only if** its width and height match the actual image, else a FOV
pinhole model is used and a warning naming both sizes is logged (`:198`, `:202-214`).

### 3.3 Consumers of scan_fused

Both SLAM and Nav2 read the fused scan, so glass enters the **SLAM map** and not only the
runtime costmap:

- `config/slam_fused.yaml:19` -> `scan_topic: scan_fused`
- `config/nav2_glass.yaml:162-164` (local costmap) and `:211-213` (global costmap)

### 3.4 glass_guard

Triggered by a Create 3 `BUMP` on the raw `_do_not_use/hazard_detection` topic, because the TB4
does not republish hazards to the clean namespace (`glass_guard.py:37,95-99`). Marks a point
offset 0.03 m along the bumper's outward axis, deduplicated onto a 0.05 m grid, republished at
5 Hz as a **latched** `PointCloud2` on `bump_obstacles` (`:75-79,132-138`). Nav2 consumes it in a
layer with `clearing: false`, so the lidar cannot erase it (`nav2_glass.yaml:184-185,237-238`).
Fresh hits also go to `bfs_explorer`, which blacklists them and cancels an in-flight goal within
1.0 m (`bfs_explorer.py:133-145`).

**Caveat if you claim glass_guard never commands motion:** `reactive_backup` defaults `False` in
both Python (`glass_guard.py:55`) and C++ (`glass_guard_node.cpp:51`), but
`autonomous_mapping.launch.py:104` overrides it to `True`. The claim holds for the C++ container
and the standalone defaults, not for the full autonomous launch.

### 3.5 The C++ port

Package `guide_mate_perception`, four executables (`CMakeLists.txt:24-46`). Verified topic and
parameter parity with the Python nodes. The container node owns **one** `tf2_ros::Buffer` and
**one** `TransformListener` shared by all three behaviour nodes on a `MultiThreadedExecutor`
(`container_node.cpp:36-48`), which matters because each additional TF listener costs ~16% of a
Pi-4 core just parsing `/tf` (`README.md:26-28`). Validated: `/turtlebot468/tf` subscription
count is 1 and the behaviour nodes own 0 TF subs (`README.md:31-32`).

Benchmarks, quoted from `src/guide_mate_perception/README.md:40-45`:

| Node | Python | C++ | Ratio |
|---|---|---|---|
| `depth_lidar_fusion` | 52.4% | 3.7% | ~14x |
| `bfs_explorer` | 95.8% | 5.7% | ~17x |
| `glass_guard` | 17.8% | 1.8% | ~10x |
| aggregate | ~166% | ~11% | ~15x |

Shared-TF container idles at ~1.5% for all three nodes plus the TF node in one process.
**These are DOC-ONLY.** There is no benchmark script, log or test artifact in the repo. Cite as
reported measurements on the platform, not as a reproducible benchmark.

### 3.6 The speed cap, stated precisely

The paper's "0.15 m/s" is true but needs qualification, because there are two different
mechanisms and one of them is looser than 0.15:

| Path | Limit | Where |
|---|---|---|
| Nav2 DWB controller | `max_vel_x: 0.15`, `max_speed_xy: 0.15` | `nav2_glass.yaml:89,93` |
| Nav2 velocity smoother, the final gate before `cmd_vel` | **0.26 m/s**, 1.0 rad/s | `nav2_glass.yaml:313-316` |
| Moses / bridge path (this is the one Sec. III is about) | `MAX_LINEAR = 0.15`, `MAX_ANGULAR = 1.5`, `MAX_TOTAL_S = 30.0`, hard-clamped per step | `choreography.py:9-11,32-38,41-51` |
| Device shadow | `max_speed` clamped to `min(shadow, MAX_LINEAR)`, so the shadow can only tighten | `safety.py:48-52` |

Safe sentence: "the language-driven path is hard-clamped to 0.15 m/s, 1.5 rad/s and 30 s per
primitive, and the navigation stack's local planner is separately limited to 0.15 m/s."

Also note `nav2_glass.yaml` sets `use_sim_time: true` in twelve places, while
`nav2_no_motion.yaml` sets it false and documents why (with true and no `/clock`, every Nav2 node
hangs in activation, `docs/mapping/bringup-no-motion.md:51-53`). Do not describe `nav2_glass.yaml`
as real-robot-ready without that caveat.

---

## 4. Subsystem B: the Moses cloud service

FastAPI on EC2 behind Caddy, which terminates TLS and auto-provisions the certificate
(`Caddyfile:1-3`, `compose.yaml:21-33`). Two containers, one host. The app publishes **no** host
port; only Caddy binds 80 and 443.

**Credentials.** No static AWS keys anywhere. The instance carries
`guidemate-agent-profile` (`deploy/launch_ec2.sh:199`), boto3 and awscrt both use the default
provider chain, and the IoT WebSocket signer refetches frozen credentials per signing call so
role rotation is transparent (`mqtt_link.py:30-48`). The admin password is minted **on the
instance** with `openssl rand -hex 16` and pushed to SSM Parameter Store as a SecureString,
deliberately never through EC2 user-data, which is API-readable for the instance lifetime
(`deploy/user_data.sh:46-52`, rationale `launch_ec2.sh:11-13`).

**The turn.** A fresh Strands `Agent` is constructed per turn so admin flag flips apply on the
next message (`dog_agent.py:474-485`, rationale `:3-7`). Model id default is
`us.anthropic.claude-sonnet-4-6` (`config.py:52`). Region default `us-west-2`.

**System prompt** is layered (`dog_agent.py:151-199`): an admin DynamoDB override wins outright,
otherwise persona blocks, then conditional emote/motion/KB instruction blocks, then a fixed
speech-style and honesty block, then the visitor's name and a recap of the last 10 messages.

**Retrieval.** `bedrock-agent-runtime.retrieve` with `numberOfResults` default 4
(`kb.py:70-77`). Failure handling matters for the compliance section and the draft gets it
right, with three refinements:

- any exception returns the literal string `"knowledge base unavailable"` (`kb.py:37,78-80`);
- a **successful but empty** retrieval returns a *different* string,
  `"no relevant knowledge found"` (`kb.py:38,82-83`);
- if the module itself will not import, a **third** string appears one layer up,
  `"knowledge base is unavailable right now"` (`dog_agent.py:324,329`).

All three are tool-result strings, not exceptions, so the model receives them inside the turn
loop and answers from parametric memory. The only counterweight is the `HONESTY` prompt block
(`dog_agent.py:57-61`), which is a request, not a constraint. Seed KB documents are four
markdown files in `docs/agent-poc/kb-seed/`: King Husky lore, Moses/robot facts, Northeastern
University, Northeastern Vancouver.

**Voice.** In: 16 kHz mono PCM16, captured by an `AudioWorkletProcessor` and sent as binary WS
frames (`static/chat.js:470-522`), consumed by Amazon Transcribe streaming by default or
ElevenLabs Scribe v2 realtime if a key is present (`speech.py:237-254`). Out: ElevenLabs
`eleven_flash_v2_5` with runtime fallback to Polly neural voice `Justin`
(`speech.py:61-82`). Audio is **not** streamed to the browser: the whole clip is joined and sent
as one base64 JSON frame (`speech.py:58,82`, `ws_chat.py:217-221`).

**Ordering, which is a real finding.** In `_run_pipeline` the order is: agent turn, emote release
gate, reply frame, **physical command dispatch**, then TTS (`ws_chat.py:123-231`). Dispatch was
deliberately moved ahead of TTS so that an early socket close can no longer cancel a queued
command mid-sequence (`ws_chat.py:189-191`). Emote-to-audio synchronisation is client-side: the
emote is armed on the reply frame and released on the audio element's `play` event, with a 3 s
fallback timer so a failed TTS never freezes the avatar (`chat.js:302-338`).

**State.** DynamoDB `guidemate-sessions`, `guidemate-messages`, `guidemate-requests`,
`guidemate-config` (`sessions.py:26-29`). The config table also holds the robot lock as
`pk = "robot_lock#{robot_id}"` and the last 10 assign events per robot (`sessions.py:190-207`,
`:251-271`). Live robot presence, battery, dock state and ack waiters are in-memory only
(`mqtt_link.py:21-27,62-65`).

**Observability.** Structured JSON logs to CloudWatch via the awslogs driver
(`compose.prod.yaml:1-16`), metrics via CloudWatch Embedded Metric Format printed to stdout with
all exceptions swallowed so telemetry can never crash a turn (`metrics.py:18-49`). Emitted:
`TurnLatencyMs`, `WsTurnLatencyMs`, `AckRoundTripMs` dimensioned by robot, `BedrockInputTokens`,
`BedrockOutputTokens`, and `PiHeartbeat` from the Pi.

---

## 5. Subsystem C: the on-robot bridge

One Python process on the Pi, a pip venv package rather than a colcon one, started by
`guidemate-bridge.service` with `ROS_SUPER_CLIENT=True` so it discovers the boot-service DDS
graph (`systemd/guidemate-bridge.service:27-30`). Threads: main, one command worker, a heartbeat
thread, a telemetry ROS spin thread, and in armed builds a motion ROS spin thread.

**Ingress.** MQTT over X.509 mutual TLS (`iot_client.py:39-50`), `clean_session=False`,
`keep_alive_secs=30`, and a Last Will publishing `{"event":"offline"}` on ungraceful disconnect
(`:33-38,44-45`). One subscription, `guidemate/{robot_id}/cmd` at QoS 1 (`bridge.py:152-155`).

**Message handling** (`bridge.py:117-136`): schema validation, then a stop pre-empt that aborts
in-flight choreography on the MQTT callback thread before enqueueing, then dedupe against a
256-entry ring, then a single-worker queue so exactly one command executes at a time.

**Egress.** Everything goes to one topic, `guidemate/{robot_id}/status`: acks
(`received`/`running`/`done`/`failed` with a reason, a `simulated` flag and the current gate
values), a 30 s heartbeat carrying battery, dock state, uptime and gates, and online/offline
lifecycle events (`messages.py:45-66`, `telemetry.py:150-188`).

**Two bugs worth citing in the LLM-development narrative**, both fixed and both in git:

- **rclpy double-init race** (commit `4f19227`). Two rclpy users could race the check-then-act
  `if not rclpy.ok(): rclpy.init()`. The loser raised, and when the loser was the telemetry
  daemon thread the exception was swallowed: `docked` stayed `None` forever, which the dock guard
  treats as docked, so it default-denied every non-exempt command, and action results were lost
  because nothing spun the node. Fixed with a single-owner lock-guarded `ensure_rclpy_init()`
  (`ros_init.py:11-23`) plus a guarded thread target that logs
  `"telemetry ROS thread DIED ... dock-guard will default-deny motion"` (`telemetry.py:65-77`).
  This is a clean example of a silent failure whose *symptom* was a safety system behaving
  correctly, which is why it survived so long.
- **Create 3 undock hangs when already undocked** (commit `9a8fc49`). The goal is accepted and
  the result never arrives, so the client burns the full 75 s window and returns a timeout. Fixed
  cloud-side: assigning an already-undocked robot is treated as a pure handover and skips
  undock and nudge entirely (`robot_lifecycle.py:44-62`).

Also `docs/agent-poc/2026-07-06-...` records that a FastDDS discovery-server registry rots after
weeks of uptime, turning boot-time participants into graph ghosts so dock/undock hangs at
"Waiting for an action server" while topics still flow. Fixed without a reboot by restarting
`discovery.service turtlebot4.service guidemate-bridge.service` (`CLAUDE.md:85-95`).

---

## 6. The authority model, end to end

This is the part of Sec. III the rest of the paper leans on, so it is worth getting exactly
right. A command from the model to the wheels passes these checks. Failure of any one is a
refusal, and every default is the safe value.

| # | Check | Where | Condition | On failure |
|---|---|---|---|---|
| 1 | Robot lock | cloud | session must hold `robot_lock#{id}`, granted only by an authenticated operator approving a companion request | session is virtual |
| 2 | Tool withholding | cloud | `run_motion` and `stop` are only added to the tool list for a lock-holding session | tool literally absent from the turn |
| 3 | Schema validation | cloud and robot | pydantic `Command` validator plus an application whitelist | `ValidationError`, no publish; robot logs and drops with no ack |
| 4 | Effective dry-run | robot | `env_dry_run OR shadow_dry_run`, so env can only tighten | logs the would-be twists, acks `done simulated=True`, publishes nothing |
| 5 | Gate wired | robot | fail-closed if the motion gate was never wired | zero twist, ack `failed "motion gate unwired"` |
| 6 | `motion_enabled` | robot, from shadow | shadow must have armed motion; **refuses even `stop`** | zero twist, ack `failed "motion_disabled"` |
| 7 | Dock guard | robot | if docked, only `dock`, `undock`, `stop` are exempt. **Unknown dock state counts as docked** | zero twist, ack `failed "docked"` |
| 8 | Clamps | robot | 0.15 m/s, 1.5 rad/s, 30 s total, applied at build and re-applied per shadow max_speed | command truncated, never rejected |
| 9 | Per-tick abort | robot | abort event checked before every publish, worst case 100 ms to zero | loop exits, trailing zero twist |

Citations: 1 `sessions.py:219-228`; 2 `dog_agent.py:128-149`; 3 `messages.py:34-42` and
`bridge.py:118-122`; 4 `safety.py:29-31` and `executor.py:179-192`; 5 `executor.py:198-204`;
6 `bridge.py:53-54`; 7 `bridge.py:44,55-56` with `None` mapped to docked at `:355`;
8 `choreography.py:9-11,32-51`; 9 `executor.py:93-102`.

**A documentation bug to note:** the systemd drop-in comment claims `command_permitted` "treats
None as not docked and stops gating on dock state"
(`systemd/guidemate-bridge.service.d/telemetry-topics.conf:10-11`). The code does the opposite.
The comment is stale; the code default-denies. Trust the code.

### The three interlocks on robot 468

Worth a paragraph in the paper, because it is a concrete instance of default-deny by
construction rather than by policy. Motion on 468 requires **three independent switches**, in
different systems, and a git change alone never moves the robot
(`docs/agent-poc/motion-toggle-runbook.md`):

1. A code escape hatch, gated on `GUIDEMATE_SUPERVISED_468_MOTION == "observer-present"`. The
   committed default has no escape hatch at all: `assert_motion_identity_safe` raises
   `SystemExit` at process start if `GUIDEMATE_ENABLE_MOTION` is set on 468, and an unset robot
   id defaults to 468 so unset is also refused (`bridge.py:60-69`).
2. A Pi systemd drop-in that is deliberately **not in git**.
3. The AWS device shadow desired state.

The base unit is grep-guarded by a unit test that fails if anyone adds
`Environment=GUIDEMATE_ENABLE_MOTION` to it (`tests/test_install_motion_ban.py:36-63`). For the
supervised runs on 2026-07-08 the code hatch was applied as a **transient uncommitted edit on the
Pi**, so nothing armed ever landed in git and the Pi's dirty `git status` was the tell
(`motion-toggle-runbook.md`, ARM step 1 variant). Disarm is AWS first, because a shadow delta
disarms the live bridge immediately, then the Pi.

So the paper's sentence "the full path ... was exercised under human observation" is accurate,
and you can say precisely what "under human observation" was enforced by.

---

## 7. Command vocabulary

The draft calls this "a small, closed, schema-validated simple-movement vocabulary". Correct,
but the closure boundary is the **schema**, not the model, and the two sets differ.

**LLM-reachable, exactly six:**

| Type | Name | Motion produced |
|---|---|---|
| `emote` | `happy` | 3 wiggle cycles, time-reversed so net displacement is ~0 (`choreography.py:72-80`) |
| `emote` | `yes` | 2 forward-nod cycles (`:54-60`) |
| `emote` | `no` | rotational shake, net yaw 0 (`:63-69`) |
| `motion` | `circle` | radius clamped to [0.1, 0.57] m, turns to [0.5, 3.0] (`:83-94`) |
| `motion` | `spin` | one revolution at 0.9 rad/s (`:97-99`) |
| `stop` | `stop` | single zero twist plus a pre-emptive abort (`:124-125`, `bridge.py:123-127`) |

**Service-emitted but not LLM-reachable, three more:** `dock`, `undock` (Create 3 ROS actions,
never twists) and `forward` (the post-undock nudge, `speed 0.1`, `duration 2.0`, ~0.2 m). These
are issued by the assignment lifecycle, not by the model
(`messages.py:16`, `robot_lifecycle.py:23-26,36-42,58-67`).

Two further precision points:

- The model **cannot supply parameters**. `run_motion(name: str)` takes only a name; the params
  are server-chosen constants (`dog_agent.py:253,353`). "Timed" is enforced downstream by the
  clamps, not by the cloud schema, and `Command.params` is an unvalidated free dict
  (`messages.py:31`).
- The prompt **requires** an emote on every reply: "You MUST call the send\_emote tool exactly
  once per reply" (`dog_agent.py:63`). So a lock-holding session emits at least one actuating
  command per turn, except when the turn also ran a trick, in which case the WS layer suppresses
  the emote publish (`ws_chat.py:159-162`).

---

## 8. Numbers you can cite, with provenance

| Claim | Status | Source |
|---|---|---|
| Fusion injected **195** beams, raised 0 | **DOC-ONLY, single hardware trial** | `docs/mapping/depth-perception.md:143-145` |
| Depth saw the base on **205** beams over 0.37 to 1.63 m | **DOC-ONLY, same trial** | `depth-perception.md:12-13,143-144` |
| C++ fusion 3.7% vs Python 52.4% of a Pi-4 core | **DOC-ONLY**, no artifact | `guide_mate_perception/README.md:40` |
| Aggregate ~166% to ~11% | **DOC-ONLY** | `README.md:43` |
| TF listener costs ~16% of a core | **DOC-ONLY** | `README.md:26-28` |
| One TF subscription in the container | **VALIDATED**, stated as an observed count | `README.md:31-32` |
| 0.15 m/s, 1.5 rad/s, 30 s clamps | **IN CODE**, unit-tested | `choreography.py:9-11` |
| Nav2 DWB 0.15 m/s | **IN CODE** | `nav2_glass.yaml:89,93` |
| `cmd_vel` at 10 Hz | **IN CODE**, default in both bridge and executor | `bridge.py:79`, `executor.py:53` |
| 30 s heartbeat | **IN CODE** | `telemetry.py:150` |
| ~14 W idle undocked | **DOC-ONLY**, measured | `docs/power.md:18` |

Recommended phrasing for the 195-beam result, since it is one trial and the wording matters:
"in a single hardware trial facing the glass wall, depth returned the metal base on 205 beams
between 0.37 and 1.63 m, of which fusion injected 195 into the scan while raising none." Note
that "where the raw lidar had reported open space" slightly overstates it: injection also covers
beams where the lidar saw *through* the glass to a farther wall.

---

## 9. Suggested replacement text for the two wrong sentences

For the Moses front-end paragraph:

> Moses never actuates the robot directly. It may only emit commands from a small, closed,
> schema-validated vocabulary of six primitives: three emotes that are short, self-cancelling
> body motions (a wiggle, a nod and a shake), two motion tricks, and a stop. The model supplies
> only a name; durations, speeds and radii are server-chosen constants, and every primitive is
> clamped on the robot to 0.15 m/s, 1.5 rad/s and 30 s before any velocity is published.

For the fusion cost sentence:

> The fusion node was ported to C++ to fit the Pi 4 compute budget, where it measured 3.7% of a
> core against the Python node's 52.4%, roughly a fourteen-fold reduction.

For the voice sentence:

> ... and drives spoken interaction through streaming text-to-speech and speech-to-text, with
> Amazon Transcribe as the default recogniser and Amazon Polly as the synthesis fallback.

---

## 10. One cross-section issue for the co-authors

This belongs to Sec. VI, not Sec. III, but it was found while mapping Sec. III and it
contradicts a claim the security section currently makes.

Sec. VI states: "The gate is enforced by omission, a session that holds no robot is never handed
a motion tool at all, so it is dry-run by construction rather than by refusal."

That is true of the WebSocket plane and of session-aware `POST /api/chat`. It is **not** true of
the legacy branch of `POST /api/chat` when `session_id` is omitted (`app.py:232-233`), which
runs:

```python
# Legacy (no session): physical against the caller-named / first robot.
user_name, history, physical = None, None, True
target = robot_id or (self._robot_ids[0] if self._robot_ids else None)
```

(`dog_agent.py:440-442`). That path is unauthenticated, requires no companion request, no
operator approval and no robot lock, sets `physical=True`, and runs on `app.state.agent`, which
holds the **real publishing** registry (`app.py:119-125`). So `send_emote`, `run_motion` and
`stop` are all offered and all publish to `robot_ids[0]`.

The vocabulary stays closed on that path. The authorization does not. In the current deployment
nothing moves, because gates 4 through 7 in section 6 above are all in their safe state and 468
additionally refuses motion at process start. But the sentence as written is wrong, and the
honest framing is stronger anyway: it is exactly the paper's own thesis that the cloud-side
authority check failed while the deterministic robot-side checks held.

---

## 11. What not to claim

- Do not claim the deployed front end can guide anyone to a room. It commands timed primitives.
  Destination resolution through Nav2 exists only in simulation.
- Do not describe the benchmarks or the 195-beam result as reproducible measurements. They are
  reported single-run numbers with no artifact in the repo.
- Do not say "speed capped to 0.15 m/s" without saying which path, given the smoother is 0.26.
- Do not say glass_guard never commands motion without excluding `autonomous_mapping.launch.py`.
- Do not present `nav2_glass.yaml` as real-robot-ready without the `use_sim_time` caveat.
- Do not call the Create 3 firmware version verified; it appears only in `CLAUDE.md`.
