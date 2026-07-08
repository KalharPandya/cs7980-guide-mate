# P8 Task 4 report — real cmd_vel + dock/undock sinks behind a triple gate + hard robot-id guard

## Status
COMPLETE. Full bridge suite green: **93 passed** (baseline was 52 → +41 new/changed).
No real ROS in unit tests (rclpy/actions/threading all faked/injected).

## Merged reality vs brief (key adaptation)
The brief's `main()` targets a Phase-2 `SafetyLayer` object with methods
`effective_dry_run()/motion_enabled()/docked()/ros_node()/on_motion_disabled()`. That
class was **never delivered** — the merged reality (052505f) has the passive
`SafetyState` (properties/`gates()`) + `ShadowSync` (applies deltas) + `Telemetry`
(sets docked). Per the brief's explicit FLAG ("adapt these call sites only — the gating
logic and hard guard are unchanged") I mapped every call site onto the real API and kept
all 8 safety invariants structurally enforced:
- `safety.effective_dry_run` (property) fed to the runner as a **live callable**
  `lambda: safety.effective_dry_run`.
- `safety.gates()["motion_enabled"] / ["docked"]` drive the live `_motion_gate`.
- `safety.max_speed` fed as a **live callable** `lambda: safety.max_speed`.
- Kill-switch: added `ShadowSync.set_motion_disabled_callback` + a delta hook (fires only
  when a delta flips `motion_enabled`→false), wired in `main()` to `bridge.abort`.
- Node access: `Telemetry` owns its rclpy node privately, so `_build_motion_sinks()`
  creates a dedicated `guidemate_bridge_motion` node + `SingleThreadedExecutor` spun in a
  daemon thread (only reached AFTER the triple gate passes — never on 468). This ROS glue
  is not unit-tested (no real ROS) but is unreachable behind the gates.

## The 8 safety obligations — structurally enforced AND tested
1. **Hard robot-id guard** — `assert_motion_identity_safe(env)` (SystemExit on ENABLE_MOTION
   + robot_id turtlebot468 incl. **unset default**); called first in `main()`.
   Tests: `test_identity_guard_refuses_motion_on_468`,
   `_when_robot_id_unset_defaults_468`, `_allows_motion_on_sim`, `_noop_when_motion_off`.
2. **Triple gate** — pure `resolve_motion_enabled(env, effective_dry_run,
   shadow_motion_enabled)`; gates `_build_motion_sinks` in `main()`.
   Tests: 4-case truth table (`test_resolve_motion_*`).
3. **Fail-closed gate (T3 obligation C)** — executor realdrive now REFUSES when
   `motion_gate is None and not dry_run` (reason `"motion gate unwired"`, wheels zeroed),
   before any drive/action. Tests: `test_no_motion_gate_when_not_dry_run_refuses_and_zeroes`,
   `test_no_motion_gate_refuses_actions_too`.
4. **Live dry-run (T3 obligation D)** — `dry_run` may be a callable, re-read per dispatch
   via `_is_dry_run()`; `main()` passes `lambda: safety.effective_dry_run`.
   Test: `test_dry_run_read_live_not_snapshotted` (flips the live source → simulated flips).
5. **max_speed re-plumb** — realdrive `build(cmd, max_speed=self._max_speed_value())`;
   `main()` passes `lambda: safety.max_speed`. Test:
   `test_realdrive_applies_dynamic_max_speed_clamp` (0.05 clamps circle's 0.12).
6. **command_permitted exemption matrix** — pure fn; **15-case** matrix test
   (`test_dock_guard_exemption_matrix`): shadow lock supreme; docked refuses all motion
   except undock/dock/stop; undocked allows all.
7. **Kill-switch** — stop cmd → `runner.abort("stopped")` in `on_message`
   (`test_stop_command_aborts_runner`); shadow delta motion_enabled→false → callback →
   `bridge.abort` (`test_shadow_motion_disabled_delta_aborts_bridge`,
   `test_delta_disabling_motion_fires_killswitch`, plus a negative
   `test_shadow_delta_without_motion_disable_does_not_abort`).
8. **CmdVelPublisher + DockActions with fakes** — new modules; `test_cmd_vel_publisher.py`
   (1) + `test_dock_actions.py` (5), all injected fakes / no ROS. Bridge fully migrated to
   the realdrive path (drops `safety=`, forwards the v8 params — no double-wire footgun).

## Installer motion-ban (boundary requirement)
- `systemd/guidemate-bridge.service`: explicit ban comment; never sets
  `GUIDEMATE_ENABLE_MOTION`.
- `scripts/install_bridge_on_pi.sh`: aborts (`exit 1`) if the rendered template ever grows
  an `Environment=GUIDEMATE_ENABLE_MOTION` directive (regex-anchored so it doesn't self-match
  the ban comment).
- `tests/test_install_motion_ban.py` (4 tests): renders the unit via the installer's sed
  substitutions and asserts no motion directive survives; proves the installer grep guard
  fires on a poisoned unit and passes on the real one.

## Adaptations / deviations from brief
- Adapted `main()` to the real `SafetyState`/`ShadowSync`/`Telemetry` (no `SafetyLayer`).
- dry_run + max_speed passed as **live callables** (obligations D + 5) rather than the
  brief's static `effective_dry_run` snapshot — the T3 review obligations override the
  literal brief here.
- Added `Bridge(max_speed=...)` param (not in brief) to plumb the live clamp.
- Executor `_real_runner` test helper now defaults to a permissive gate (the fail-closed
  contract makes `motion_gate=None` refuse); `test_no_sink_when_not_dry_run_acks_failed`
  updated to wire a permissive gate so it still exercises the "no cmd_vel sink" path.
- Kill-switch hook lives on `ShadowSync` (not a nonexistent `SafetyLayer`).

## Concerns
- `_build_motion_sinks()` (rclpy node + executor spin) is ROS glue that cannot be
  unit-tested here; it is only reachable when `resolve_motion_enabled` is True, which is
  structurally impossible on robot 468 (hard guard) and requires an operator to set
  `GUIDEMATE_ENABLE_MOTION=1` + shadow motion_enabled + dry_run off + `GUIDEMATE_ROS=1`.
  Needs an on-sim smoke test (out of scope: no real ROS in this task).
- The obligation-C fail-closed change flipped the executor's `motion_gate=None` default
  semantics (was "allow"); T3 executor tests updated accordingly (documented above).

## Test command
`PYTHONPATH=$PWD/shared/guidemate_msgs:$PWD/src/guide_mate_bridge .venv/bin/pytest
src/guide_mate_bridge/tests/ -v` → 93 passed.
