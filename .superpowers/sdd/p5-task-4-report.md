# Phase 5, Task 4 — `/ws/chat/{session_id}` WebSocket (report)

Transcript/text → agent turn → emote-sync → reply text + Polly audio, **released
together** (emotes synchronized, never delayed/early). Implemented as
`agent_service/guidemate_agent/ws_chat.py` and wired into the FastAPI app in
`app.py`.

> **Code-review round 2 (verdict Needs-fixes, no Critical) — addressed.** See the
> "Code-review fixes" section at the end. Headline change: the WS turn now runs
> through DogAgent's **session-aware** path, and **DogAgent is the single
> persistence owner** (the WS layer no longer persists). The sections below marked
> with ⚠️ describe the pre-fix design; the fixes section is authoritative.

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

---

# Code-review fixes (round 2)

Merged `origin/kalhar/dog-agent-poc` (tip `9ae7707`, P6-T5's `app.state.s3` +
maps routes) first — `app.py` auto-merged cleanly; both P6-T5's lifespan
additions and my WS wiring coexist (both are additive).

## Persistence owner decision: **DogAgent** (single owner)
Previously the WS layer ran `agent.chat(text, robot_id=target)` (no `session_id`),
which took DogAgent's LEGACY path: `history=None`, `physical=True`
unconditionally, and `target` fell back to the hardcoded `self._robot_ids[0]`. The
WS layer then persisted the two messages itself. Two problems: (1) every WS turn
lost conversation memory + name greeting and a virtual session was wrongly given
physical framing / could name a robot it isn't bound to; (2) two persistence
owners risked double-writes if we ever passed `session_id`.

Fix: the WS turn now calls **`agent.chat(text, session_id=session_id)`**, routing
through DogAgent's session-aware branch (`dog_agent.py` `_resolve_session`) which:
- loads `user_name` + last-10 history (memory + name greeting);
- sets `physical = (bound robot is not None)` → a virtual session gets
  virtual-honest wording ("virtual emote played (avatar only)"), and
  `run_motion`/`stop`/`get_status` are withheld (never names an unbound robot);
- resolves the **per-session** bound robot (never a hardcoded id);
- **persists both the user + assistant messages itself.**

The WS layer's own `_persist` helper and its `sessions` import were **removed** —
DogAgent is the sole persistence owner, so there is exactly **one user row + one
dog row per turn** (asserted by `test_ws_virtual_turn_is_session_aware_and_single_persist`
and `test_ws_physical_turn_publishes_to_bound_robot`).

The real physical emote publish + release gate still live in the WS layer (owned,
per the Phase-5 decision): `_physical_target()` resolves the publish target via the
`robot_target_resolver` seam, whose **default is now the authoritative
`sessions.robot_for_session`** (was a virtual-only `lambda: None`). So virtual →
`None` → `emote_sync` publishes nothing and releases immediately; robot-bound →
the bound id → real publish + order-independent gate. This keeps the WS publish
target consistent with DogAgent's own internal resolution.

## Hardened receive loop (IMPORTANT #2)
The outer loop previously only caught `WebSocketDisconnect`, so a malformed JSON
text frame (`json.loads`) or a client-declared `sample_rate < 16000`
(`downsample_pcm16` raises `ValueError`, it only downsamples) propagated uncaught
and killed the endpoint silently. Now each received message is handled inside a
**per-message `try/except`**: `WebSocketDisconnect` still breaks the loop cleanly;
any other exception → `log.exception` + a `{"type":"error"}` frame + **continue**
(if even the error send fails, the socket is gone → break). `ws.receive()` itself
is also guarded for disconnect.

## Minor fixes
- **start_audio leak:** a second `start_audio` without an intervening `stop_audio`
  now closes the prior `TranscribeSession` (`_safe_finish`) before opening a new
  one, instead of leaking it.
- **Deprecation:** `asyncio.get_event_loop()` → `asyncio.get_running_loop()` inside
  the `_run_pipeline` coroutine.

## Tests added/extended (`test_ws_chat.py`, now 8 tests)
Restructured into two layers:
- **Protocol (minimal app + fakes):** virtual reply+audio + session-aware routing
  assertion; physical publish + telemetry; blank-message ignored; dropped-ack
  timeout fallback; **malformed-JSON frame → error frame + socket survives a
  following good turn**; **bad `sample_rate` → error frame + socket survives** (a
  no-op `_FakeTranscribe` keeps the audio path off AWS).
- **Integration (real app + `GUIDEMATE_FAKE_ROBOT` + moto + faked Bedrock):**
  `test_ws_virtual_turn_is_session_aware_and_single_persist` — memory-capable
  session path, virtual framing (`get_status`/`run_motion` withheld), **no
  publish**, exactly `["user","dog"]` persisted (no double-persist);
  `test_ws_physical_turn_publishes_to_bound_robot` — emote published to the
  per-session bound robot, `get_status` offered, single persistence.

The old `test_text_message_persists_user_and_assistant` (which asserted a
WS-layer persist) was removed — persistence moved to DogAgent.

## Adaptation note
Changing the `robot_target_resolver` default from virtual-only (`lambda: None`) to
`sessions.robot_for_session` is a deliberate deviation from the original brief
("virtual-only default installed here"): the authoritative binding surface exists
now, and the review requires the WS to publish to the per-session bound robot. The
seam is preserved for a Phase-4 override.

## Re-verification
`PYTHONPATH= .venv/bin/pytest -q` (full `agent_service/tests`): **196 passed, 17
skipped** (skips pre-existing playwright/integration). App imports cleanly.
`test_ws_chat.py`: 8 passed.
