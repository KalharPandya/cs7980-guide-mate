# Phase 5, Task 5 report — polished user-facing dog-chat UI

## What was built
- **Rewrote** `agent_service/static/index.html`.
- **Created** `agent_service/static/chat.css`, `agent_service/static/chat.js`.
- **Added** two small routes in `agent_service/guidemate_agent/app.py` — `GET /chat.js`
  and `GET /chat.css` — because nothing served root-level static assets before (the
  old page was a single self-contained file with inline `<style>`/`<script>`). Placed
  next to the existing `GET /` `index()` route, before the `/admin` mount, matching
  that file's established pattern (explicit `FileResponse` routes, not a root
  `StaticFiles` mount, so they can't shadow `/api/*` or `/admin`).
- **Extended** `agent_service/tests/test_app.py` (`test_index_served`,
  new `test_chat_static_assets_served`) instead of adding a separate test file.

## UI structure
- `#intake` — name + "comfortable around Physical AI Dogs" checkbox + Start button,
  styled as a warm card (kept from the pre-existing flow — see adaptation below).
- `#chat` (hidden until a session exists) — companion banner, an inline-SVG dog
  avatar (ears/head/eyes/snout, no emoji), a scrollable message list of chat
  bubbles, and a composer: push-to-talk mic button with a live level meter, text
  input, Send, and a "New session" reset.
- A status chip (`#status-chip` / `#status-mode`) in the header shows `virtual` /
  `physical` at a glance.
- A toast (`#toast`) surfaces `{type:"error"}` frames and mic/session errors
  without freezing the rest of the UI.
- Theme-aware: CSS custom properties driven by `prefers-color-scheme` plus
  `:root[data-theme]` overrides (same pattern as `static/admin/admin.css`).
- Distinctive visual direction (not a templated Bootstrap look): warm amber/ink
  palette, serif display font stack, pill-shaped controls throughout, a hand-drawn
  inline-SVG mascot with a subtle idle "breathing" scale animation so the avatar
  reads as alive even between turns.

## Emote ↔ audio sync (the explicit hard requirement)
The WS turn ships two frames back-to-back: `{type:"reply", text, emote, ...}` then
`{type:"audio", format:"mp3", b64}`. Playing the emote animation on the `reply`
frame (as an earlier draft did) would fire it *before* the voice starts — visibly
out of sync whenever TTS synthesis takes any time at all.

Implementation (`chat.js`):
1. On `reply`, the emote is only **armed** (`armPendingEmote`) — the text bubble
   renders immediately (good UX — you see what Robert said right away), but the
   avatar does not move yet.
2. On `audio`, an object-URL blob is set on the hidden `<audio id="player">` and
   `.play()` is called.
3. The `<audio>` element's own `play` event — fired at the exact moment playback
   actually starts, after browser decode/buffering — is what calls
   `triggerEmote()`. This is the sync point: animation and voice start on the
   same tick, not on message arrival.
4. Two fallbacks so a dropped/failed audio path never leaves the dog frozen:
   `play()`'s rejection handler (autoplay-policy block) triggers the emote
   immediately, and a 3s arm-timer releases it anyway if no `audio` frame ever
   arrives (e.g. the server's `tts failed` best-effort path in `ws_chat.py`).

## Mic / PCM streaming
Push-to-talk button → `getUserMedia({audio:true})` → `AudioWorkletNode` (inline
`Blob` module, no separate file) grabs raw `Float32Array` frames at the device's
native sample rate → linear-resampled to 16 kHz → converted to signed Int16 LE →
sent as WS binary frames, framed by `{type:"start_audio", sample_rate:16000}` /
`{type:"stop_audio"}` per the real `ws_chat.py` protocol. A muted `GainNode` keeps
the worklet in the audio graph (required for it to be pulled) without echoing the
mic back to the speakers. A live RMS-based level meter bar gives visual feedback
while recording.

## Status chip / companion banner — reality check vs. the brief
The brief speculated `/api/session/{id}/state` would eventually return
battery/dock/motion-lock/robot-connected fields "once Phase 4 lands." Phase 4 is
**already merged** on this branch, and the real endpoint
(`guidemate_agent/sessions.get_session_state`) returns exactly
`{"request_status": ..., "robot_id": ...}` — no battery/dock telemetry exists yet.
`chat.js`'s `renderState()` reflects that real shape: chip = `physical` iff
`robot_id` is set, banner text keyed off `request_status` (`pending` /
`denied` / `aborted` / none). Poll interval is 3s (not the brief's 4s) — see
adaptation below.

## Brief-vs-reality adaptations
1. **Kept the intake step + its exact DOM ids/strings, instead of the brief's
   "random UUID, no intake" design.** The brief assumed `/api/session/{id}/state`
   didn't exist yet and that Task 5 could stand alone with a client-generated
   UUID. In the merged tree, `/api/session` (create), `/api/session/{id}/state`,
   and `/api/session/{id}/request-companion` are all live and **404/require a
   real session row** (`sessions.get_session(id) is None` → 404). A pure random
   UUID would make the status chip and the companion-request button silently
   404 forever. So `index.html`/`chat.js` keep the pre-existing intake gate
   (`#name`, `#comfortable`, `#start` → `POST /api/session`) that mints a real
   session id, then reveal `#chat`. Only the *presentation* changed (warm card,
   not a bare form).
   Chat itself (WS turns) doesn't strictly need this — `DogAgent._resolve_session`
   does `sessions.get_session(session_id) or {}`, so an unknown id degrades
   gracefully — but the status chip / banner / companion-request button do need it.
2. **Preserved the existing gated Playwright e2e's contract.**
   `agent_service/tests/e2e/test_companion_flow.py` (Phase-4 exit criteria,
   `GUIDEMATE_E2E=1`-gated, real DynamoDB, 3-user-context flow) drives the page via
   `#name`/`#comfortable`/`#start`/`#chat:not([hidden])`, clicks `#request-companion`,
   and asserts on the *exact substrings* `"Virtual dog"`, `"Request pending"`,
   `"Connected to turtlebot468"`, `"disconnected by admin"`. The rewrite keeps
   every one of those ids and exact phrases (`renderState()` / the request-button
   click handler in `chat.js`), and keeps the **3-second** poll interval the test's
   own docstring assumes ("banner flips within ~6s / two polls", `8000ms` deadlines)
   — the brief's draft used 4s, which was adopted instead only where it doesn't
   collide with that timing assumption. This test does need real AWS credentials to
   run and was not exercised end-to-end in this sandbox (no AWS creds available
   here), but its selectors/strings were verified by direct source inspection.
3. **Real emote vocabulary is `happy`/`yes`/`no`** (confirmed in
   `guidemate_agent/dog_agent.py`'s `EMOTE_INSTRUCTION`), matching the brief's
   `wiggle`/`nod`/`shake` mapping — no drift there.
4. **Added `/chat.js` and `/chat.css` routes** to `app.py` (not in the brief,
   which only listed the three static files to write) — without them the browser
   gets 404s for both assets and the page renders unstyled with no JS.

## Test coverage
- `PYTHONPATH= .venv/bin/pytest -q` from repo root: **326 passed, 17 skipped**
  (skips are the pre-existing `integration`/`live`/`e2e` gates, unrelated to this
  change) — confirmed **no regressions**. (Built a fresh `.venv` in this worktree
  since the shared checkout's `.venv` has editable installs pointing at the other
  checkout's paths, not this worktree's files.)
- Extended `agent_service/tests/test_app.py`:
  - `test_index_served` now also asserts every DOM hook chat.js / the gated e2e
    depends on is present in the served HTML (`#intake`, `#name`, `#comfortable`,
    `#start`, `#chat`, `#avatar`, `#companion-status`, `#request-companion`,
    `#messages`, `#chat-form`, `#message`, `#mic`, `#status-chip`, and the
    `/chat.css`/`/chat.js` links).
  - New `test_chat_static_assets_served`: `GET /chat.js`/`GET /chat.css` return
    200 with the right content-types; a balanced-braces/parens check on the JS
    body as a syntax-error proxy (no JS runtime — no `node`/`deno`/`jshell`-JS
    available in this sandbox); asserts the emote-sync contract markers
    (`armPendingEmote(msg.emote)`, `player.addEventListener("play"`) and the WS
    URL pattern are present in the shipped file (not just in this report).
  - Ran a real headless-Chromium smoke via Playwright (installed into the
    worktree's fresh `.venv` for this task) against a live
    `GUIDEMATE_FAKE_ROBOT=1` uvicorn: page loads, `#intake`/`#name`/`#start` are
    visible, `#chat` starts `hidden`, and **zero** `console.error`/`pageerror`
    events fire — i.e. `chat.js` parses and executes cleanly in a real browser,
    not just my brace-counting proxy.
  - Did **not** attempt to drive the full intake → chat → WS turn flow live: that
    needs `POST /api/session` to succeed, which hits real DynamoDB
    (`sessions.py` uses `boto3.resource` directly, no moto/mock seam), and this
    sandbox has no real AWS credentials — confirmed by a `UnrecognizedClientException`
    from a manual attempt. This is exactly what `test_companion_flow.py`
    (`GUIDEMATE_E2E=1`) already covers on a machine with real AWS access, and
    per the task's guidance P5-T7 owns the dedicated fake-mic e2e — not
    duplicated here.

## What's wired vs TODO
**Wired:**
- Full WS text-chat round trip: send `{type:"text"}`, render `transcript`/`reply`/
  `audio`/`error` frames.
- Push-to-talk mic → 16kHz PCM16 → `start_audio`/binary/`stop_audio`.
- Emote animation synced to audio playback start, with fallbacks.
- Status chip + companion banner, wired to the real (already-merged) Phase 4
  `/api/session/{id}/state` and `/api/session/{id}/request-companion` endpoints.
- WS reconnect on drop (1.5s retry), suppressed on tab unload.
- Error toast for `{type:"error"}` frames and mic failures — never wedges the UI.

**TODO / left for later work:**
- No dedicated automated e2e for the mic/PCM path in this task (that's P5-T7's
  fake-mic e2e, intentionally not duplicated here).
- The status chip is binary (virtual/physical) since the real state endpoint
  doesn't yet expose battery/dock telemetry; if/when it does, `renderState()`
  in `chat.js` is the single place to extend.
- `test_companion_flow.py`'s full flow (real AWS, `GUIDEMATE_E2E=1`) was not
  re-run end-to-end here for lack of AWS credentials in this sandbox — should be
  re-verified on a machine with real AWS access before considering Task 5 fully
  closed against that regression surface.
