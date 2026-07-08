# Assignment → movement → disassignment dock lifecycle

**Date:** 2026-07-08 · **Branch:** `kalhar/dog-agent-poc` · **Status:** approved design

## Goal
Make robot 468's dock behavior complete and verified across the full guest lifecycle:
- **On assignment** ("comes back"): robot wakes, **undocks**, then moves **~0.2 m straight
  forward** (teleop twist, NO navigation) to clear the dock.
- **On end of assignment**: robot **docks** — for ALL three end paths.

Everything is bounded twist / Create 3 dock actions. **No Nav2, no waypoints, no autonomous
navigation anywhere.**

## Audit — what exists vs. what's missing
Existing (`agent_service/guidemate_agent/sessions.py`):
- `_bind_robot` fires a best-effort `undock` on assign; `abort_robot`/`reassign_robot` fire a
  best-effort `dock` on unassign. Outcomes recorded via `_record_assign_event` /
  `get_assign_events`, surfaced on the admin Robot tab.
- Bridge side (Phase 8): `dock`/`undock` as Create 3 ROS actions, dock-guard exemption matrix,
  `forward` twist primitive (`choreography._forward`, ~0.2 m default, hard-capped).

**Missing pieces (this spec):**
1. **No forward nudge after undock** — undock leaves the robot on/at the dock; nothing clears it.
2. **No guest-facing end of assignment** — only admin abort/reassign dock the robot; a guest
   who finishes leaves the robot undocked and locked forever.
3. **No idle cleanup** — an abandoned session holds the robot lock indefinitely.
4. **Ack window too short** — `send_command` waits 5 s, but undock/dock take 10–60 s, so assign
   events under-report (recorded as failed/empty even when the action later succeeds).
5. **`run_motion` not whitelisted** — `_motion_impl` accepts any valid motion name, so the LLM
   could emit `dock`/`undock`/`forward`. Lifecycle motions must be service-owned only.

## Architecture — per-robot lifecycle worker
New module `agent_service/guidemate_agent/robot_lifecycle.py`: a **serialized per-robot job
queue** on a background thread. Admin/guest routes enqueue and return instantly; jobs run with a
long ack window and record real terminal states.

- **Assign job**: `undock` (wait terminal ack, 75 s) → if `done`, send `forward` twist → record
  `undock` + `forward` events. Undock fail/timeout → record refusal, **skip nudge**.
- **End job**: `dock` (wait terminal ack, 75 s) → record event.
- Per-robot serialization guarantees the reassign order: old holder's `dock` finishes (or times
  out) before the new holder's `undock`.
- `_send_assignment_command` is replaced by enqueue calls; `_record_assign_event` reused as-is.
- Long wait uses `registry.send_command(..., timeout_s=75, collect_all=True)` off the hot path.

Single in-memory queue is fine — POC runs one service instance (same assumption already
documented on the robot lock).

## End-of-assignment paths (all → dock)
1. **Guest end**: `POST /api/session/{session_id}/end` + an "End session" button in the chat UI.
   Marks session `ended`, releases the lock, enqueues `dock`.
2. **Idle timeout**: chat + WS turns stamp `last_active_ts` on the session row. A sweeper on the
   existing autonomy scheduler cadence ends any robot-holding session idle > **10 min**
   (`IDLE_TIMEOUT_S`, configurable) → release + dock.
3. **Admin abort/reassign**: unchanged semantics, now routed through the queue with verification.

## Safety / scope
- **`run_motion` whitelist**: `_motion_impl` restricted to `{"circle","spin"}`; `dock`/`undock`/
  `forward` are lifecycle-only and never LLM-reachable.
- Robot 468 arming is unchanged and orthogonal (see `docs/agent-poc/motion-toggle-runbook.md`).
  With 468 disarmed (dry-run) the whole lifecycle runs and records `simulated` acks; when armed
  it drives for real. No code toggles arming.
- Teleop reality: the Create 3 `Dock` action needs the dock in IR view (~1 m, facing). The
  human teleops the robot near the dock before ending; a failed dock is recorded + shown, robot
  stays put.

## Testing
- **Unit** (fake registry, no ROS): queue serialization; undock→nudge only on undock `done`;
  nudge skipped on undock failure; dock on each end path; idle sweeper; `run_motion` whitelist.
- **e2e**: dry-run stack — approve fires undock+nudge (simulated acks recorded), guest end +
  admin abort both dock, reassign docks-then-undocks in order.
- **Wet on 468**: arm via runbook (observer + kill-switch) → approve → observe undock + ~0.2 m
  nudge → teleop back → end session → observe dock → disarm again.

## Out of scope
Nav2, waypoints, autonomous navigation, multi-instance concurrency, changing the arming model.
