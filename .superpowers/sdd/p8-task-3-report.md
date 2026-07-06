# Phase 8 Task 3 — Executor real-drive path + dock/undock action dispatch + abort/kill-switch

## Status: DONE

## What was built
The `ChoreographyRunner` (`src/guide_mate_bridge/guide_mate_bridge/executor.py`) now has the
Phase-8 **real cmd_vel drive path**:

- **Fixed-rate, abort-aware twist loop** (`_drive_step`): each `TwistStep` is published at
  `publish_hz` for `round(duration*hz)` ticks; a shared `threading.Event` (the kill switch)
  is checked **between** publishes, so a `stop`/shadow-kill zeroes the wheels within one
  publish period and aborts. Clean finish AND abort both end by publishing the zero twist.
- **`abort(reason)`** — thread-safe kill switch (sets the Event). `handle()` **clears** the
  event right after the `running` ack, so a stale stop only kills the command in flight when
  it fired (verified: `test_abort_does_not_persist_across_commands`).
- **dock/undock as Create 3 ROS ACTIONS** via `run_action` — the executor branches BEFORE
  `build()` (which raises `ValueError` for dock/undock). Real path: gate → `run_action(name)`
  → `done(simulated=False)` / `failed(reason)`; missing client → `failed("no action client")`.
  Dry-run: log `DRY-RUN action <name>`, `done(simulated=True)`, **never** calls the client.
- **Command-aware `motion_gate`** (`Callable[[Command], (bool, reason)]`) — the hook for
  Task 4's `command_permitted` dock-guard exemption matrix. Consulted for twist AND action
  commands (shadow lock beats the undock exemption). On refusal it publishes a safety
  zero-twist (if a sink exists) then acks `failed(reason)`.
- Dry-run (effective) invariant holds: never publishes a twist, never runs a real action.

## Key adaptation (merged-reality reconciliation — IMPORTANT for Task 4)
The brief's Step-3 said "replace the entire contents" with a signature that **drops
`safety`** in favour of `dry_run`/`motion_gate`/`run_action`. That brief was written against
the Phase-1 executor. **Merged reality is the Phase-2 executor**: it takes
`safety: SafetyState`, `bridge.py` constructs `ChoreographyRunner(publish_ack=..., safety=safety)`,
and 9 existing tests depend on the SafetyState path (gates snapshot + `simulated` on every ack,
internal docked/motion_enabled refusal). A verbatim replace would have broken `bridge.py`,
`test_bridge.py`, and those 9 tests.

**Resolution:** `safety` is now an **optional** ctor arg. `handle()` dispatches:
- `safety` given  → `_handle_legacy` = the Phase-2 path, preserved byte-for-byte.
- `safety` absent → `_handle_realdrive` = the brief's v8 real-drive path (what all 10 new
  tests construct, and where the abort loop / actions / motion_gate live).

This keeps integration + all prior tests green while delivering the brief's v8 behaviour
exactly. Blast radius stayed within `executor.py` + `test_executor.py` (the brief's task
boundary); `bridge.py` untouched.

## Follow-ups for Task 4 (integration)
- Rewire `bridge.py` onto the v8 path: pass `motion_gate=command_permitted`,
  `run_action=DockActions(...)`, `publish_twist=CmdVelPublisher`, and drive `abort()` from the
  `stop` command + shadow kill-switch.
- The v8 `dry_run` is a **static ctor bool**; it will NOT track live shadow dry-run changes
  the way the Phase-2 `safety.effective_dry_run` (read per-`handle`) does. Task 4 must supply
  dry-run live (e.g. read `safety.effective_dry_run` at dispatch and construct/route
  accordingly), or the shared SafetyState kill semantics regress.
- dock/undock actions are not abort-interruptible mid-action (short self-terminating Create 3
  behaviors); abort applies to twist choreographies and between commands (documented).

## Tests
`PYTHONPATH=$PWD/shared/guidemate_msgs:$PWD/src/guide_mate_bridge .venv/bin/pytest src/guide_mate_bridge/tests/ -v`
→ **52 passed** (whole bridge suite). test_executor.py = **19 passed** (9 legacy Phase-2 +
10 new Phase-8). No real ROS; fakes for publish_twist/run_action + threading via the `sleep`
hook. Worktree imports verified (`import guide_mate_bridge.bridge, .executor` OK).
