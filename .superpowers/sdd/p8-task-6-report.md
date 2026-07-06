# Phase 8 — Task 6 report: the Gazebo sim PHYSICALLY MOVES (evidence run)

**Date:** 2026-07-06 · **Branch:** worktree of `kalhar/dog-agent-poc` · **Sim only:**
thing `Turtlebot-Sim`, robot_id `turtlebotsim`, certs `~/.aws/guidemate-sim.*`.
Robot 468 / `Turtlebot-468` never referenced; no SSH to the Pi.

## TL;DR

**The sim PHYSICALLY MOVED and the circle CLOSED.** One clean full-suite run on a
freshly launched sim (single Gazebo, single bridge, RTF 0.962):

```
test_dock_guard_and_undock_lifecycle_over_iot  PASSED
test_circle_closes_and_turns_full              PASSED   closure 0.067 m, |net_yaw| 6.414 rad
test_kill_switch_zeros_cmd_vel_within_1s       PASSED   0.223 s shadow-flip -> zero cmd_vel
test_redock_via_iot_unassign                   XFAIL    (upstream sim re-dock wedge, documented)
=================== 3 passed, 1 xfailed in 219.69s ===================
```

No assertion was weakened (closure < 0.15 m, |net_yaw| ≥ 5.5 rad, kill ≤ 1.0 s, RTF
precheck ≥ 0.85 all stand as written). The residual failures beyond the already-fixed
orphaned-Gazebo RTF cause were traced to **two more stacked causes** (a stale duplicate
bridge racing acks, and the sim Create 3 hazard reflex suppressing cmd_vel after
undock) plus one deterministic physics term (wall-clock pacing × RTF), each fixed at
its root. No-regression: main repo `334 passed, 20 skipped`; worktree (changed code)
`334 passed, 24 skipped` (the 4 extra skips are this sim suite skipping without
`GUIDEMATE_SIM=1`, as designed).

## Root cause narrative (three stacked causes, found in this order)

The original P8-T6 failure was **closure 0.998 m ≈ the 0.5 m circle's diameter** (half a
loop). That single number turned out to be **three independent causes stacked**, each
found by measurement, each with its own fix:

### Cause 1 — orphaned duplicate Gazebo halves the real-time factor (prior session)

A stale Gazebo instance from an earlier crash loaded the box: **RTF 0.49 with the
orphan vs 0.94 clean**. The bridge's choreography was wall-clock-timed, so at RTF≈0.5
only half the sim time was delivered → half a circle → closure ≈ diameter.
**Fixes (committed on the merged branch, tip `0dde26a`):** `launch_sim.sh` refuses to
start over a stale sim (`pgrep -x ruby` / `pgrep -x parameter_bridg` — 15-char comm
truncation); the test measures RTF via `/clock` as a fail-loud precheck (≥ 0.85).

### Cause 2 — stale guide-mate BRIDGE from a previous session races the acks (this session)

With a clean single sim, the suite still failed — bizarrely: a **docked** circle was
acked `done simulated=True` instead of the dock-guard's `failed reason=docked`, and the
undock never moved the robot. Found by `ps`: **PID 177770, a leftover
`guide_mate_bridge.bridge` from the previous agent's worktree (started 00:31), still
connected under the same robot_id `turtlebotsim`**. Two bridges subscribed to the same
command topic; the stale one (dead sinks, locked shadow snapshot) answered first, so the
test's terminal-ack scan picked up its bogus `done simulated=True`, masking the live
bridge's correct refusal. The live bridge's own log showed the shadow delta applied
(`gates {'docked': True, 'motion_enabled': True, 'dry_run': False}`) and **no** command
handling — the proof the ack came from elsewhere.
**Fix:** killed by PID; `launch_sim.sh` now also refuses to start when a
`guide_mate_bridge.bridge` process already exists (second stale-orphan class, same guard
family as Cause 1).

### Cause 3a — sim Create 3 `motion_control` hazard reflex suppresses cmd_vel after undock

Fresh sim, single bridge, healthy RTF 0.961 — and the cold circle STILL failed at
**0.997 m** (the original signature!). A `/hazard_detection` + `/odom` + `/clock` +
`/cmd_vel` trace recorder nailed it:

* **5090 hazard messages, types {0=BACKUP_LIMIT, 2=CLIFF}**, streaming continuously for
  ~44 s from sim start (the dock plate misfires the simulated cliff sensors; undock's
  backward drive then trips the backup limit).
* While the reflex holds, external cmd_vel is **ignored entirely**: the first
  post-undock spin commanded wz=0.9 for 6.9 s → odom wz **0.000** the whole time, net
  yaw **0.000 rad**. The first forward drive (the circle) was ignored for its first
  **~10.5 s** (odom wz 0.000 vs cmd 0.24), then tracked perfectly → net yaw only
  **3.300 rad** → closure 0.997 m ≈ diameter.
* Once released, tracking is EXACT from t=0: odom wz **0.2400** vs cmd 0.24, odom vx
  **0.1200** vs cmd 0.12, zero hazards, no odom gaps.

**Fix (setup, not assertions):** the test's warm-up is now a throwaway **spin + circle**
that absorbs the suppression window before the measured circle. (Disabling the reflex
via `safety_override` was deliberately NOT done — no weakening of the robot's safety
stack, even in sim.)

### Cause 3b — wall-clock choreography under-delivers the arc by exactly (1 − RTF)

With suppression absorbed and perfect velocity tracking, closure error is the **chord of
the RTF shortfall**: `closure = 2·R·sin(π·(1−RTF))`. Measured series (R=0.5 m):

| RTF (during circle) | predicted closure | measured closure |
|---|---|---|
| 0.49 (orphan Gazebo) | 1.00 m (≈diameter) | **0.998 m** (original failure) |
| 0.880 | 0.37 m | **0.479 m** (some residual suppression) |
| 0.904 (cold, suppressed 10.5 s) | — | **0.997 m** |
| 0.913 (precheck) | ~0.27 m | **0.528 m** (partial suppression) |
| 0.941 | 0.184 m | **0.171 m** |

`closure < 0.15 m` requires **RTF ≥ 0.952** — not reliably reachable on a shared box
(measured RTF here swung 0.88–0.96 with ambient load). This is deterministic physics,
not flake: the odom trace shows the sim robot executing the commanded twist perfectly.
**Fix (root cause, in the bridge):** `GUIDEMATE_SIM_TIME_CHOREO=1` (exported by
`launch_sim.sh` only) makes the executor pace choreography ticks by **/clock (sim
time)** — `_build_sim_time_sleep()` in `bridge.py`, with a wall-clock fallback and a
capped wait so a dying sim can't hang the abort/kill-switch path. The real robot is
untouched: flag unset → `time.sleep` wall pacing, byte-identical behavior (wall time ==
robot time on hardware, RTF ≡ 1).

## Captured evidence (final clean run, 2026-07-06 ~08:40 UTC)

Fresh sim (robot docked at start), single Gazebo, single bridge, sim-time pacing on
(`choreography paced by SIM time (/clock)` in the bridge log). Verbatim `[evidence]`
prints from the passing run:

```
[evidence] dock-guard: docked circle refused state=failed reason=docked
[evidence] undock over IoT: ack state=done, /dock_status is_docked True->False
[evidence] rtf=0.962 circle closure=0.067 m start=(-0.408,-0.032) end=(-0.461,-0.073)
[evidence] circle net_yaw=6.414 rad over 1694 odom samples
[evidence] kill-switch cmd_vel zeroed 0.223s after shadow flip
=================== 3 passed, 1 xfailed in 219.69s (0:03:39) ===================
```

Per-assertion:

| assertion | bound | measured | verdict |
|---|---|---|---|
| RTF precheck | ≥ 0.85 | **0.962** | pass |
| circle closure | < 0.15 m | **0.067 m** | pass — the sim drove a full 0.5 m-radius circle back to its start |
| circle net yaw | ≥ 5.5 rad | **6.414 rad** (full 2π + decel trailing) | pass |
| kill-switch zeroing | ≤ 1.0 s | **0.223 s** (shadow `motion_enabled:false` mid-circle → zero `/cmd_vel`; in-flight command acked `failed`) | pass |
| dock-guard refusal | state=failed, reason=docked | **state=failed reason=docked** (docked circle over IoT) | pass |
| undock over IoT | ack done + is_docked flips | **ack state=done, /dock_status True→False** | pass |
| re-dock over IoT | ack done + is_docked True | **XFAIL (strict)** — upstream irobot_create sim never releases the docking-behavior slot after undock; the bridge dispatches the Dock action faithfully and acks the sim's rejection | documented |

Independent trace cross-check (parallel `/odom` + `/cmd_vel` + `/clock` +
`/hazard_detection` recorder during the passing run): the measured circle ran
**27.68 s wall delivering 26.62 s sim** (commanded 26.18 s of arc — the /clock pacing
stretching wall time by exactly 1/RTF as designed), odom velocity tracking exact
(wz mean **0.2400** vs cmd 0.24, vx **0.1200** vs cmd 0.12, tracking from ~0.2 s),
**0 hazard messages** during the measured circle. The wheels moved because the sim
physically drove them — not because anything was mocked.

## Environment / procedural notes

* Worktree venv: `python3 -m venv .venv` + editable installs of
  `shared/guidemate_msgs`, `src/guide_mate_bridge`, `agent_service` + `boto3 pytest`
  **+ `numpy==2.2.6`** — ROS 2 Humble message modules (`geometry_msgs`, `sensor_msgs`)
  import numpy at module load; without it the bridge crashes at motion-sink build.
* Every shell: `unset ROS_DISCOVERY_SERVER; ros2 daemon stop; ros2 daemon start`
  (login profile points DDS at the Pi's discovery server).
* `PYTHONPATH` for the test run must APPEND the worktree `src` to the ROS paths
  (`PYTHONPATH="<worktree>/src:$PYTHONPATH"` after sourcing ROS) — overwriting it
  removes `rclpy`.
* Kill sims by PID only (`pkill -f` self-matches the invoking shell). `parameter_bridge`
  truncates to `parameter_bridg` (15-char comm limit).
* **Ignition bring-up wedge (found + fixed):** two launches wedged forever at
  "Requesting list of world names" with zero errors logged — `ss -tlnp` showed the
  Gazebo server's ign-transport ZeroMQ sockets bound to **172.17.0.1 (the docker0
  bridge interface)**, so server↔client discovery silently failed. `/dock_status`
  existed in the graph but had no publisher; the tell is the bridge heartbeat missing
  its `docked`/`battery` fields. Fix: `export IGN_IP=127.0.0.1` in `launch_sim.sh`
  (verified: sockets on 127.0.0.1, bring-up deterministic after). Health-check
  heartbeats for `"docked":` before starting the suite.

## Files changed (this task)

* `src/guide_mate_bridge/guide_mate_bridge/bridge.py` — `_build_sim_time_sleep()`
  (/clock-paced choreography, opt-in via `GUIDEMATE_SIM_TIME_CHOREO`, wall fallback +
  capped wait so the kill-switch stays responsive); `Bridge(..., sleep=)` passthrough
  to the executor. Real-robot path (flag unset) byte-identical (`time.sleep`).
* `src/guide_mate_bridge/tests/test_sim_motion.py` — warm-up extended to spin +
  throwaway circle (absorbs the post-undock hazard-reflex suppression window);
  comments updated with the traced mechanism; **all assertions unchanged**. All
  historical measured values preserved in the comments.
* `sim/launch_sim.sh` — stale-**bridge** guard (in addition to the stale-Gazebo
  guard); `IGN_IP=127.0.0.1` (docker0 wedge); `GUIDEMATE_SIM_TIME_CHOREO=1` export
  with the measured closure-vs-RTF table in the comment.
* `.superpowers/sdd/p8-task-6-report.md` — this report.

## Teardown (executed)

* Sim shadow reset to LOCKED: `aws iot-data update-thing-shadow --thing-name
  Turtlebot-Sim ... {"motion_enabled":false,"dry_run":true}` → accepted, shadow
  **version 232**.
* All sim/bridge/launch processes killed **by PID** (never `pkill -f`); verified
  `pgrep -x ruby`, `pgrep -x parameter_bridg`, and the bridge process list all empty.
* Robot 468 / `Turtlebot-468` untouched throughout (bridge ran as `turtlebotsim` with
  the sim certs; `assert_motion_identity_safe` additionally hard-refuses 468).
