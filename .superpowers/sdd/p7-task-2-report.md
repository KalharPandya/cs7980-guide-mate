# Phase-7 Task 2 report — EMF metrics instrumentation + /readyz

## What was done
- `dog_agent.py`: added `_usage_from_result(result) -> Optional[tuple[int,int]]`
  (guarded — never raises, handles missing/odd `metrics.accumulated_usage` and
  plain-string results). `_emote_impl` and `_motion_impl` now time their
  `send_command` call and emit `AckRoundTripMs` (Milliseconds, dim `robot_id`).
  `chat()` emits `BedrockInputTokens`/`BedrockOutputTokens` when
  `_usage_from_result` returns a value.
- `app.py`: `/api/chat` wraps the agent call, emits `TurnLatencyMs`
  (Milliseconds) in a `finally` (recorded on both success and failure), and
  emits `ErrorCount` (Count=1) on any caught non-`HTTPException` exception
  before re-raising. New `GET /readyz` returns
  `{"ready": bool, "checks": {"mqtt": bool, "dynamo": bool}}`, 200 when both
  true else 503; both checks are wrapped in `try/except` so a dependency
  outage never 500s the probe.
- `mqtt_link.py`: added `RobotRegistry.is_connected` (cheap property,
  `self._conn is not None`).
- `fakes.py`: added `FakeRobotRegistry.is_connected` (always `True`).
- New test file `agent_service/tests/test_metrics_instrumentation.py` (8
  tests): `_usage_from_result` (3), `AckRoundTripMs` from both `_emote_impl`
  and `_motion_impl` (2), `TurnLatencyMs` + `ErrorCount` on `/api/chat` (2),
  `/readyz` both states (2) — all assert EMF JSON lines via `capsys`.

## Adaptations from the brief (reality wins)
1. **`/readyz` shape**: brief specified `{"creds", "registry"}`; implemented
   `{"mqtt", "dynamo"}` per this task's explicit "Merged reality" instructions
   — `app.state.registry` is always set once lifespan completes (even after a
   failed MQTT connect), so "registry is not None" is a useless check. The
   real signal is the MQTT link state (`RobotRegistry.is_connected`, newly
   added). "creds" was folded into "dynamo" (`ConfigStore.get_flags()`, which
   already has its own 5s TTL cache, wrapped in try/except) since AWS creds
   are needed to reach Dynamo anyway.
2. **`_emote_impl`/`_motion_impl` bodies**: the brief's drafted replacement
   bodies predate the merged tree's physical/virtual lock-gating and
   `captured["acks"].extend(...)` (not `=`). Adapted by wrapping the *existing*
   merged bodies with the `t0`/`emit_metric` timer around `send_command`
   rather than replacing them with the brief's stale snapshot. Both
   `_emote_impl` and `_motion_impl` are instrumented (the brief only mentioned
   `_emote_impl`; this task's instructions explicitly call out both).
3. **`chat()` token emission**: inserted right after the merged tree's
   `result = agent(message)` / `reply_text = str(result)` lines (the brief's
   snapshot predates session-aware `chat()` and its `_wrap`/session-persist
   logic).
4. **`/api/chat` route**: the brief's replacement (`app.state.agent.chat(req.message)`
   only) predates the session-aware route (session lookup, `HTTPException`
   404, session_id threading). Kept the merged route's branching intact and
   wrapped it in `try/except/finally` for `ErrorCount`/`TurnLatencyMs` instead.
   No `boto3` "creds" check was added (unused now that `/readyz` uses
   mqtt/dynamo, not creds/registry).
5. Test file's own fake registry needed `.simulated` (not just `.model_dump()`)
   on its ack stand-in, since the merged `_emote_impl` reads `acks[-1].simulated`
   to pick the return string — the brief's fake only covered `model_dump()`.

## Test summary
- New file: 8/8 passed.
- Full `agent_service/tests/`: 141 passed, 14 skipped (pre-existing
  integration/live/e2e markers, unaffected).
- Full repo suite (`pytest -q` at repo root): 206 passed, 14 skipped.

## Concerns
- `TurnLatencyMs` is emitted even for the 404 "unknown session" path (an
  `HTTPException`, not a real turn) — low-signal noise but harmless; left as
  is for simplicity per the "wrap the DogAgent.chat call" instruction.
- `RobotRegistry.is_connected` is a coarse signal (reflects whether `connect()`
  built a connection object, not a live ping) — matches the "cheap" property
  called for in the task brief; a real liveness ping would need broker RTT
  and was out of scope.
