# On-Robot Stack Test — Motion Bring-up as a Bisection Ladder (468)

**Date:** 2026-07-06
**Robot:** `turtlebot468` (host `turtlebot-van-468`, `ubuntu@10.247.204.21`)
**Context:** Operator physically co-located with 468, on the same LAN (no tunnels). A
**human observer is present**, which is the precondition the whole stack was built to wait
for before motion. Goal: verify the entire stack layer-by-layer with motion gated OFF, then
enable real motion **only as the final rung** so that any motion failure is fault-isolated to
exactly one layer.

## The one safety-critical decision

The codebase **hard-bans motion on 468 by design**: `bridge.py:assert_motion_identity_safe()`
does a `SystemExit` if `GUIDEMATE_ENABLE_MOTION` is set while the robot id is `turtlebot468`
(unset id defaults to 468 → also refused). The ban was a proxy for "no unobserved motion."
That condition no longer holds (observer present), so we **temporarily and reviewably lift the
ban for this test, then revert it** (L6a + Teardown). Nothing else about the safety design
changes: the shadow lock, dock guard, and dry-run all stay enforced and are unlocked in small
supervised sub-steps.

## Principle: bisection ladder

Each rung is proven with motion still OFF, bottom to top. Because a dry-run command still walks
the *entire* pipeline and acks `simulated=true` (executor logs `DRY-RUN twist …` but never
publishes), rungs L0–L5 exercise everything **except the final wheel publish**. When we finally
enable motion (L6) and something fails, every layer beneath is already green → the fault is one
of: the cmd_vel sink build, the Create 3 accepting the twist, the undock action, or hardware.
Each rung below names its own failure meaning.

## Roles, preconditions, kill-switch

- **Cloud/SSH side (agent):** AWS shadow reads/flips, agent commands via echo.kalhar.ca, reading
  acks/telemetry/bridge journal over SSH, the ban-lift edit + Pi sync, live-site review.
- **Physical side (operator):** all on-Pi motion supervision, undock, watching, and the
  **primary kill-switch — physically powering/stopping the robot.**
- **Secondary kill-switch:** the admin kill-switch on echo.kalhar.ca (confirmed by operator to
  work). The physical stop is primary because it does not depend on the stack under test; Stop is
  itself verified at 6c against the smallest possible motion.
- **Bridge status (verified 2026-07-06):** `guidemate-bridge.service` active, dry-run, additive;
  robot_id `turtlebot468`; Pi repo `kalhar/dog-agent-poc @ 85556c6` (laptop at `49af39e` —
  reconcile before L6a).
- **Repo gotchas honored:** never `pkill -f` on the Pi (kill by PID / `ps comm`); on-Pi ROS work
  runs on the Pi's own terminal/session, not launched-and-abandoned from a laptop shell.

---

## L0 — LAN + reachability  *(no robot involvement)*
- **Do:** SSH laptop→Pi; confirm Pi→AWS IoT MQTT connect; ROS 2 discovery alive on the Pi.
- **PASS:** `ssh guidemate hostname` = `turtlebot-van-468`; bridge journal shows a recent IoT
  connect + heartbeats; `ros2 topic list` (sourced) lists the `/turtlebot468/*` base topics.
- **Breaks here →** network / IoT creds. Nothing downstream can work.

## L1 — Bridge up + shadow LOCKED  *(verify, already deployed)*
- **Do:** confirm the running bridge publishes `reported` gates; read the Device Shadow.
- **PASS:** shadow `reported` = `motion_enabled:false, dry_run:true` and `docked:true`; heartbeats
  current (uptime advancing).
- **Breaks here →** bridge process / IoT auth / shadow sync — not the command path.

## L2 — Telemetry up-path  *(read-only; robot never moves)*
- **Do:** Create 3 → bridge → IoT → cloud. Observe battery, dock state, pose flowing up.
- **PASS:** live telemetry visible cloud-side and on echo.kalhar.ca (status/Arsenal); reported
  `docked:true` matches the robot actually being docked.
- **Breaks here →** base↔bridge topics or the up-path. Down-path untouched.

## L3 — Command down-path, DRY-RUN  *(full pipeline, zero motion — the decisive rung)*
- **Do:** from the live agent, ask for a trick ("spin"). dog_agent → `send_command` → IoT command
  topic → bridge → executor **dry-run branch**.
- **PASS:** acks `received → running → done` with `simulated=true`; bridge journal shows
  `DRY-RUN twist vx=… wz=… dur=…`; **wheels do not move.**
- **Breaks here →** agent tool wiring / IoT routing / executor. Proves everything but the final
  publish.

## L4 — Gates provably BLOCK  *(adversarial — confirm the locks deny)*
- **Do:** with locks closed, force motion and confirm refusal: expect `failed reason=motion_disabled`;
  while docked, a non-undock motion → `failed reason=docked`.
- **PASS:** each gate returns its correct refusal reason. This is what licenses the L6 unlock.
- **Breaks here →** a gate is not enforcing → **STOP, do not proceed to L6.**

## L5 — UI / agent surface
- **Do:** echo.kalhar.ca against the live robot — motion tools appear only when
  `motion_tools_enabled`; Stop is persistent; status label reflects the real robot.
- **PASS:** review-agent visual pass of the site against real telemetry.

---

## L6 — MOTION, escalated  *(only after L0–L5 green; operator on the Pi, physical kill-switch in hand)*

> Before starting L6: operator confirms the floor is clear, the robot has room, and a hand is on
> the physical stop. The admin kill-switch page is open as backup.

- **6a — Arm the sink, keep the shadow LOCKED.**
  Reconcile Pi↔laptop commits; apply the **reviewed ban-lift** edit to
  `assert_motion_identity_safe` (allow 468 under explicit opt-in); push; `git pull` + rebuild on
  the Pi; set `GUIDEMATE_ENABLE_MOTION=1` in the bridge unit env; restart the bridge — **shadow
  still `motion_enabled:false, dry_run:true`.**
  **PASS:** bridge builds the real cmd_vel sink **yet still refuses** any motion (dry-run/gate).
  Robot does **not** move.
  **Breaks here →** sink build / DockActions client / env wiring.

- **6b — Undock** (Create 3 ROS *action*, not a twist; lowest-risk first actuation, reversible).
  A real undock needs effective dry-run OFF, so set shadow `motion_enabled:true, dry_run:false`
  (undock is dock-guard-exempt, so it is the one motion permitted while docked); send `undock`.
  **PASS:** robot leaves the dock; ack `done simulated=false`.
  **Breaks here →** undock action / base action server.

- **6c — Smallest real twist: in-place spin** (wz only, ~half turn, capped 0.15 m/s equivalent).
  Send the `spin` trick.
  **PASS:** wheels turn; **admin/physical Stop zeroes them within one publish period**
  (verify Stop here, with the smallest possible motion).
  **Breaks here →** cmd_vel publish path / Create 3 hazard-reflex suppressing cmd_vel.

- **6d — Tiny forward arc** (`circle` trick at the 0.15 m/s cap), floor permitting.
  **PASS:** clean arc; acks terminal `done simulated=false`.
  **Breaks here →** choreography timing / arc build.

## Teardown / rollback  *(mandatory, in order)*
1. Send `stop`; confirm wheels zeroed.
2. Send `dock`; confirm redocked, `reported docked:true`.
3. Flip shadow back to `motion_enabled:false, dry_run:true`.
4. Unset `GUIDEMATE_ENABLE_MOTION` in the bridge unit; **revert the ban-lift commit**; push;
   `git pull` + rebuild + restart bridge on the Pi.
5. Confirm the 468 motion ban is back in force (a set `GUIDEMATE_ENABLE_MOTION` again `SystemExit`s)
   and the bridge is back to locked dry-run.

## Abort criteria (any → stop, redock if undocked, re-lock)
- L4 shows any gate NOT enforcing.
- Any unexpected motion, or Stop does not zero within one publish period.
- Bridge stops heartbeating, IoT disconnects mid-rung, or acks stop arriving.
- Operator judgment — physical stop is always the right call.

## What we learn either way
If the full ladder passes, the end-to-end stack (agent → IoT → bridge → Create 3) is proven with
real motion under supervision. If it fails, the rung that fails **names the faulting layer**, and
every layer below it is already independently confirmed green — that is the entire reason for the
ladder.
