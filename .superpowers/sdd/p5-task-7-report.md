# Phase 5, Task 7 report — speech loopback integration test + fake-mic voice e2e

## What was built

- `agent_service/tests/integration/test_speech_loopback.py` — `test_polly_to_transcribe_loopback`,
  marked `@pytest.mark.live`. Synthesizes "do a happy wiggle" via `synthesize_pcm16`, feeds it in
  ~100 ms chunks to a `TranscribeSession`, asserts `"wiggle"` in the returned transcript.
- `agent_service/tests/e2e/test_voice_e2e.py` — `test_voice_in_transcript_reply_emote_audio`,
  marked `pytest.mark.e2e`. Boots a real uvicorn subprocess (`GUIDEMATE_FAKE_ROBOT=1`, no
  MQTT/robot), builds a fake-mic WAV from `synthesize_pcm16` + `pcm16_to_wav`, launches Chromium
  with `--use-fake-device-for-media-stream` + `--use-file-for-fake-audio-capture=<wav>`, drives
  the real chat page (fills the Phase-4 intake, push-to-talk via `#mic`), and asserts the full
  voice path: transcript bubble containing "wiggle" → dog reply bubble with an `.emote-tag` →
  the avatar has **no** `emote-*` class right after the reply lands → `#player` gets an audio
  `src` → the avatar **then** gets an `emote-*` class (the sync requirement, checked as two
  explicit assertions rather than one end-state check).
- `agent_service/tests/e2e/__init__.py` already existed (from an earlier merge); not recreated.

## Live results — ACTUALLY RAN, both passed

**1. Speech loopback (real Polly + real Transcribe, `us-west-2`):**
```
GUIDEMATE_LIVE=1 GUIDEMATE_INTEGRATION=1 .venv/bin/pytest agent_service/tests/integration/test_speech_loopback.py -v
agent_service/tests/integration/test_speech_loopback.py::test_polly_to_transcribe_loopback PASSED
1 passed in 1.73s
```
Adaptation: the test file lives under `tests/integration/` (per the brief), and pytest's
`item.keywords` auto-includes every path segment as a pseudo-marker — so `"integration"` was
already true for this item from its *directory*, independent of the `@pytest.mark.live` marker
I added. Both env vars are therefore required to un-skip it; documented in-file. The transcript
came back containing "wiggle" — a real 8-word Polly phrase round-tripped through streaming
Transcribe correctly.

**2. Voice e2e (real Bedrock + real Transcribe + real Polly, fake mic + fake robot):**
```
GUIDEMATE_E2E=1 .venv/bin/pytest agent_service/tests/e2e/test_voice_e2e.py -v -s
agent_service/tests/e2e/test_voice_in_transcript_reply_emote_audio PASSED
1 passed in 29.33s
```
Captured turn, live:
- Transcript bubble: contained "wiggle" (real Transcribe STT of the fake-mic WAV).
- Real Bedrock reply: *"Woof woof! 🐾 Wiggle wiggle wiggle, Voicey-33d850! So happy to see you!
  🐕💛 No tricks loaded for "wiggle" — but my tail is WAGGING super fast! You can ask me to do a
  circle or a spin if you want a real move! 🌀"* — with a `send_emote` tool call (dog reply bubble
  carried an `.emote-tag`).
- Sync assertion 1 (pre-audio): confirmed the avatar carried **no** `emote-happy`/`emote-yes`/
  `emote-no` class immediately after the reply bubble appeared (before the audio frame/blob
  existed) — proves `armPendingEmote` doesn't fire the animation early.
- Audio: `#player.src` populated (real `synthesize_mp3` mp3 blob URL).
- Sync assertion 2 (post-audio): confirmed the avatar **did** pick up an `emote-*` class once the
  audio source was set — proves the animation is gated on the `<audio>` `play` event, not the
  reply arrival, matching chat.js's actual `player.addEventListener("play", ...)` wiring.
- Real turn latency (Bedrock + Transcribe + Polly, EMF `WsTurnLatencyMs`): **13,579.5 ms**.

Both were run for real, in this environment (real AWS creds via `credential_process`,
`us-west-2`; a real X display `:0`; Playwright's bundled Chromium 149.0.7827.55 launched and
exercised the fake-mic path with no fallback/mocking).

## No-regression check

```
PYTHONPATH= .venv/bin/pytest -q   # from repo root, no gate env vars
332 passed, 19 skipped in 20.26s
```
Same pass/skip counts before and after adding the two new gated tests — they skip cleanly by
default (the `live` and `e2e` markers/env-vars), so default CI is unaffected.

## Environment setup needed (not in the brief)

This worktree had no `.venv` (git worktrees don't share it — the sibling checkout's `.venv` has
an editable install pointing at *that* checkout's `agent_service`, not this worktree's). Built a
fresh venv here: `python3 -m venv .venv`, then
`pip install -e shared/guidemate_msgs -e "agent_service[dev]"`, then
`pip install --no-deps amazon-transcribe` (deliberately not a declared dependency of
`guidemate-agent` — see the comment in `agent_service/pyproject.toml`: it hard-pins an
incompatible `awscrt` version if resolved normally), then `pip install -e src/guide_mate_bridge`
and `pip install matplotlib` to satisfy the two other workspace test suites
(`shared/guidemate_msgs/tests`, `src/guide_mate_bridge/tests`) collected by the root
`testpaths`. None of this touched application code.

## Brief-vs-reality adaptations

1. **Step 0 merge:** this worktree was stale (tip `fe63d10`, pre-dating the WS endpoint, chat UI,
   and admin tabs). Merged `origin/kalhar/dog-agent-poc` first, landing at `d068c3f` as expected —
   clean fast-forward-equivalent merge, no conflicts.
2. **Loopback test placement/gating:** kept the brief's file path and phrase, but noted (and
   verified) that the `tests/integration/` directory itself implies the `integration` gate via
   pytest's automatic path-keyword mechanism, on top of the explicit `@pytest.mark.live` marker
   I added (the brief's draft used a bare `@pytest.mark.live` with no explanation of why the file
   lives in `integration/`). Both `GUIDEMATE_LIVE=1` and `GUIDEMATE_INTEGRATION=1` are required to
   run it — documented in the file's docstring so the next reader isn't surprised.
   Also worth flagging: an **earlier task already added** a similar ad hoc live loopback test at
   `agent_service/tests/test_speech.py::test_live_polly_to_transcribe_loopback` (different phrase,
   "the quick brown fox…", gated by a bare `skipif(GUIDEMATE_LIVE)` rather than the marker
   mechanism). The two overlap in what they exercise; I left the pre-existing one alone and added
   this task's file as specified, rather than deleting/merging them (out of scope for this task).
3. **e2e gating:** the brief's draft test used an ad hoc
   `pytestmark = pytest.mark.skipif(os.environ.get("GUIDEMATE_FAKE_ROBOT") != "1", ...)`. Per the
   outer task instruction ("gate it on GUIDEMATE_E2E=1 like the other e2e tests"), I instead used
   `pytestmark = pytest.mark.e2e` — matching `test_admin_maps.py` / `test_companion_flow.py` — and
   kept `GUIDEMATE_FAKE_ROBOT=1` only as the *server's* env var (avoids MQTT/robot deps), not the
   test's skip condition. `agent_service/tests/e2e/__init__.py` already existed from an earlier
   merge (not created here).
4. **Intake seam resolved, not deferred:** the brief flagged `_reach_chat` as a TODO pending Phase
   4. Phase 4's intake gate is live in this merged tree (`static/index.html`'s `#intake` section +
   `chat.js`'s `beginSession`), so `_reach_chat` fills `#name` and clicks `#start` for real,
   rather than leaving the TODO in place.
5. **`server_url` fixture pattern:** matched the two existing e2e tests' own per-module
   `server_url` fixture (subprocess uvicorn + `/healthz` poll) instead of inventing a different
   shape — there is no shared e2e conftest in this repo, confirmed by reading both existing files.
6. **Sync assertion strengthened:** rather than only checking the emote tag/audio src eventually
   appear (as the brief's draft did), added an explicit "no emote class yet" assertion right after
   the reply bubble lands and before the audio frame, to actually prove the ordering requirement
   (emote applied in sync with audio playback, not before) rather than just asserting both events
   eventually happened in some order.

## Files

- `/home/khouryloaner/cs7980/cs7980-guide-mate/.claude/worktrees/agent-ae5278a41e715270e/agent_service/tests/integration/test_speech_loopback.py`
- `/home/khouryloaner/cs7980/cs7980-guide-mate/.claude/worktrees/agent-ae5278a41e715270e/agent_service/tests/e2e/test_voice_e2e.py`
