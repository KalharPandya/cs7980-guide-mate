# Phase 5, Task 4 — `/ws/chat/{session_id}` WebSocket (report)

Transcript/text → agent turn → emote-sync → reply text + Polly audio, **released
together** (emotes synchronized, never delayed/early). Implemented as
`agent_service/guidemate_agent/ws_chat.py` and wired into the FastAPI app in
`app.py`.

## Files
- **New:** `agent_service/guidemate_agent/ws_chat.py` — `CaptureRegistry`,
  `register(app)`, and the `_run_pipeline` turn engine.
- **Modified:** `agent_service/guidemate_agent/app.py` — imports + `app.state`
  wiring (`observability`, `ws_agent`, virtual-only `robot_target_resolver`) and
  `register_ws(app)`.
- **New test:** `agent_service/tests/test_ws_chat.py` (5 tests, all fakes).

## Wire protocol

**Browser → server** (text control frames, `type` field):
- `{"type":"start_audio","sample_rate":N}` — open a Transcribe stream (declared
  mic rate N; downsampled to 16 kHz).
- binary frames — PCM16 chunks (fed to Transcribe while a stream is open).
- `{"type":"stop_audio"}` — finalize; server emits `transcript` then runs a turn.
- `{"type":"text","message":str}` — text turn (same pipeline, no STT).

**Server → browser:**
- `{"type":"transcript","text":...}` — voice path only, before the turn.
- `{"type":"reply","text","emote","gate_released","turn_id"}` **then**
  `{"type":"audio","format":"mp3","b64":...}` — sent back-to-back, **after** the
  emote release gate, so the avatar/robot emote is in sync with the spoken reply.
- `{"type":"error","message":...}` — on any turn failure (socket stays open).

## Emote sync + timeout fallback
1. `robot_target_resolver(session_id)` resolves the physical robot bound to the
   session (Phase-4 seam; default returns `None` = virtual/free user).
2. The WS-path agent (`app.state.ws_agent`) runs the turn and *picks* the emote.
   It is a `DogAgent` backed by **`CaptureRegistry`**, so its `send_emote` tool
   reports success (keeping the reply text clean) but **publishes nothing** — the
   real publish is owned here.
3. `emote_sync(registry, target, cmd, GATE_TIMEOUT_S=2.0)` (Task 1) does the real
   publish and **gates order-independently**: it releases as soon as ANY ack
   reports `running`/`done` (AWS IoT QoS1 delivers acks out of order). If no
   confirming ack lands within 2.0 s it releases anyway with
   `gate_released=False` — **a dropped ack can never wedge the turn** (proven by
   `test_dropped_ack_still_releases_reply`).
4. Only after the gate resolves does the server send the `reply` frame
   immediately followed by the `audio` frame — text + audio ship together, in
   step with the emote.

## No-robot vs robot-bound paths
- **Virtual (resolver → None):** `emote_sync` short-circuits to `(True, [])` and
  publishes nothing; reply + audio + emote plan still return for the browser
  avatar. `registry.published == []`. This is the normal free/no-robot user flow.
- **Robot-bound (resolver → id):** emote is published to **that** robot via the
  per-session binding (never a hardcoded id); the round-trip is recorded to
  observability (`record_command`).

## Persistence & telemetry
- Both messages are persisted best-effort via `sessions.append_message(session_id,
  "user", text)` and `(session_id, "dog", reply_text)` — role `"dog"` matches the
  DogAgent convention. Wrapped so a DynamoDB hiccup never kills the turn.
- Telemetry: `observability.record_latency` (turn latency) +
  `observability.record_command` (emote round-trip) + a best-effort
  `emit_metric("WsTurnLatencyMs", ...)` EMF line. All guarded — telemetry can
  never crash the turn. Errors funnel to `observability.record_error`.

## Test coverage (5 tests, all fakes — no Bedrock/MQTT/Polly/DynamoDB)
- virtual session returns reply + audio, **no** publish;
- robot-bound session publishes `("turtlebot468","happy")` and records a command
  + latency;
- both user + assistant messages persisted, in order;
- blank/whitespace message ignored (no turn), later real message still answered
  on the same socket;
- dropped-ack timeout fallback → `gate_released=False` but reply + audio still
  ship.

`_FakeRegistry`/`_FakeAgent` are local to the test (they mirror the existing
`fakes.py` shapes); persistence is exercised through a monkeypatched
`sessions.append_message` fake so the unit tests never touch real AWS.

## Brief-vs-reality adaptations
1. **STEP 0 / worktree sync.** The isolated worktree branch was on a stale commit
   (`fe63d10`, pre-`agent_service`). Ran the STEP-0 merge (`git merge --no-edit
   origin/kalhar/dog-agent-poc`) **inside the worktree** to bring it to `a86a03a`.
2. **`app.py` is 197 lines, not the brief's 44-line snapshot.** The merged
   `lifespan` already builds `Config`, the (Fake)RobotRegistry, `ConfigStore`,
   `KBManager`, the autonomy `EventEngine` + APScheduler. I did **not** replace it
   — I *added* `observability`, `ws_agent` (DogAgent over `CaptureRegistry`, with
   `store=store`), the default `robot_target_resolver`, and `register_ws(app)`.
   `app.state.config`/`registry` already existed.
3. **Persistence added (not in the brief snapshot).** The brief's `ws_chat` never
   persisted; the task requires it. Since the WS calls `ws_agent.chat(text,
   robot_id=target)` **without** `session_id` (to keep the `CaptureRegistry`
   emote-ownership split and match the fake's signature), `DogAgent` does not
   self-persist on this path — so `ws_chat` persists both messages itself,
   best-effort.
4. **`emit_metric` turn telemetry added** per the task ("emit a turn metric via
   observability/emit_metric, best-effort") — the brief snapshot only used the
   observability ring buffers.
5. **`CaptureRegistry.send_command` signature** widened to accept
   `collect_all=False` to match the real `RobotRegistry`/test-registry signature
   (`send_command(robot_id, cmd, timeout_s=..., collect_all=...)`).
6. **Test runner.** The `.venv` lives in the main repo and editable-installs
   `guidemate_agent` from there, so the suite is run with
   `PYTHONPATH=<worktree>/agent_service` prepended (which also clears ROS
   contamination) so the worktree's code shadows the installed copy:
   `PYTHONPATH=$WT/agent_service <mainrepo>/.venv/bin/python -m pytest -q
   agent_service/tests`.

## Verification
`agent_service/tests`: **186 passed, 16 skipped** (skips are pre-existing
playwright/integration cases). App imports cleanly. Task-4 tests: 5 passed;
`test_app.py` + `test_ws_chat.py`: 22 passed.
