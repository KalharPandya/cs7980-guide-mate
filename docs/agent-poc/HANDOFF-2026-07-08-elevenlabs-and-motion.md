# Handoff to Linux Claude Code (2026-07-08)

**From:** Windows-laptop session. **Why:** the ElevenLabs voice work is done and deployed;
the open item (robot 468 physical motion) needs Pi access, and `ssh guidemate` does not
resolve from the Windows laptop. Pick this up on the Linux box (Alienware), which has the Pi
SSH alias.

## TL;DR
1. **ElevenLabs voice (TTS + realtime STT): DONE, live-validated, deployed to prod and local.**
   All on branch `feat/kalhar-elevenlabs-voice` (pushed).
2. **OPEN: robot 468 does not physically move** (no undock on assign; a "trick" replies as if it
   worked but the base never moves). Root cause is NOT a voice/agent bug: **motion is DISARMED**
   (dry-run). Commands flow and are acked, the bridge just dry-runs them.

---

## Part A: ElevenLabs voice (context, all committed)

Branch `feat/kalhar-elevenlabs-voice`. Design/plan in
`docs/superpowers/specs/2026-07-08-elevenlabs-voice-backend-design.md` and
`docs/superpowers/plans/2026-07-08-elevenlabs-voice-backend.md`.

What shipped:
- `speech.py`: `synthesize_mp3` / `synthesize_pcm16` dispatch to ElevenLabs with **Polly
  fallback** on any error/missing client; `ElevenLabsTranscribeSession` (Scribe v2 realtime
  websocket) + `make_transcribe_session()` factory (Transcribe fallback when no key). The
  realtime adapter `_eleven_scribe_connect` reads the committed transcript from the **`text`**
  field (the SDK docstring wrongly says `transcript`; verified against the live API).
- `config.py`: `GUIDEMATE_TTS_BACKEND` / `GUIDEMATE_STT_BACKEND` (default `polly`/`transcribe`),
  `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (defaults to the Moses voice `vBKc2FfBKJfcZNyEt1n6`;
  an **empty** value also falls back to Moses), model ids.
- `ws_chat.py`: TTS call + STT construction now read backend/voice/model/client from Config.
- `app.py`: builds a shared `app.state.el_client` at startup (keyless -> logs a warning, stays
  on AWS).
- `compose.yaml`: passes the four ElevenLabs env vars into the prod container (they were not in
  the allowlist, which is why a key alone did nothing).

Verified live (real key + Moses voice): TTS returns an `ID3` mp3; full TTS -> STT roundtrip
("do a happy wiggle" transcribed back as "Do a happy wiggle."). In the **prod container**:
`PROD_TTS backend=elevenlabs bytes=39750 header=b'ID3'`.

### Prod deployment state
- EC2 `i-0e1301c47f73c771c`, https://echo.kalhar.ca, redeploy via
  `agent_service/deploy/redeploy.sh` with `GUIDEMATE_BRANCH=feat/kalhar-elevenlabs-voice`.
- `/etc/guidemate.env` on the instance has `GUIDEMATE_TTS_BACKEND=elevenlabs`,
  `GUIDEMATE_STT_BACKEND=elevenlabs`, `ELEVENLABS_API_KEY=...`, `ELEVENLABS_VOICE_ID=<Moses>`.
- Key also in SSM Parameter Store SecureString `/guidemate/elevenlabs-api-key`.
- **Prod runs commit `2305f75`.** Branch tip is newer (`811a3c2` empty-voice fix + merge
  `8abdcca`). Re-run `redeploy.sh` to pull the tip when ready. Prod does not need the fix (its
  env sets the voice explicitly), so this is optional.
- **API key rotation:** the key was shared in chat and the user is rotating it. After rotation,
  update SSM `/guidemate/elevenlabs-api-key`, `/etc/guidemate.env` on the instance (then
  `docker compose ... up -d` to recreate), and any local launch env.

### Local server (Windows laptop, may be stopped after this session)
Was launched in the background as:
`ELEVENLABS_API_KEY=... GUIDEMATE_TTS_BACKEND=elevenlabs GUIDEMATE_STT_BACKEND=elevenlabs`
`ELEVENLABS_VOICE_ID=vBKc2FfBKJfcZNyEt1n6 GUIDEMATE_IOT_ENDPOINT=aqc6y1ij55nsq-ats.iot.us-west-2.amazonaws.com`
`PYTHONUTF8=1 .venv/Scripts/python -m uvicorn guidemate_agent.app:app --host 127.0.0.1 --port 8000`.
`readyz` was green (mqtt+dynamo). `PYTHONUTF8=1` is required on Windows to avoid the cp1252
emoji crash (see memory `dog-agent-local-run-windows`).

---

## Part B: OPEN issue — robot 468 physical motion (needs the Pi)

**Symptoms:** assigning the robot did not undock; asking for a trick got a success-style reply
("that is my happy wiggle") but the base did not move.

**Root cause: motion is disarmed (dry-run).** The live shadow for `Turtlebot-468`:
```
reported: { motion_enabled: false, dry_run: true, effective_dry_run: true, bridge_version: 0.2.0 }
desired:  { motion_enabled: false, dry_run: true }
```
Commands reach the robot layer (`AckRoundTripMs robot_id=turtlebot468` fired for the chat
turns), but `effective_dry_run: true` means the bridge computes the motion and publishes
nothing. Same for undock. So both symptoms are one thing: the bridge is dry-running everything.

### Per-layer state (see `docs/agent-poc/motion-toggle-runbook.md`, three switches)
| Switch | Where | State now | Evidence |
|---|---|---|---|
| 3. AWS shadow | classic shadow `Turtlebot-468` | **DISARMED** | reported `motion_enabled:false, dry_run:true` (forces `effective_dry_run:true` on its own) |
| 1. Code escape-hatch | `src/guide_mate_bridge/guide_mate_bridge/bridge.py` `assert_motion_identity_safe` | **DISARMED (git)** | function currently HARD-REFUSES `GUIDEMATE_ENABLE_MOTION` on `turtlebot468` ("motion is sim/436 only"); no `GUIDEMATE_SUPERVISED_468_MOTION == "observer-present"` branch present |
| 2. Pi systemd drop-in | Pi `/etc/systemd/system/guidemate-bridge.service.d/motion-supervised.conf` | **UNVERIFIED** | could not `ssh guidemate` from Windows; base unit default is `GUIDEMATE_DRY_RUN=1` |

So all three are (or default to) safe. Switch 3 alone is enough to block motion.

### Secondary bug (real, but not the cause of no-motion)
Moses overclaims. In dry-run it says "that is my happy wiggle" as if it moved. It should say it
is in safe/dry-run mode and cannot physically move. Consider surfacing the effective motion gate
in the reply (the WS turn already knows the acks were simulated).

### Also unverified
Whether undock-on-assign (commit `fdafd49` "undock+nudge on assign") actually SENDS an undock
command, or is itself buggy. Dry-run masks this. Verify by watching for an undock command/ack on
assign once armed (or read the lifecycle code + the Pi journal).

---

## Next steps for the Linux session

1. **Confirm switches 1+2 on the Pi:**
   ```bash
   ssh guidemate 'systemctl show guidemate-bridge.service -p Environment | tr " " "\n" | grep -iE "MOTION|DRY_RUN"; \
     ls /etc/systemd/system/guidemate-bridge.service.d/; \
     cd ~/cs7980-guide-mate && git rev-parse --short HEAD && grep -c GUIDEMATE_SUPERVISED_468_MOTION src/guide_mate_bridge/guide_mate_bridge/bridge.py'
   ```
2. **If the user wants motion:** ARM per `motion-toggle-runbook.md`, but **only with a human
   observer physically at robot 468 with a kill-switch**. Arm all three, verify `reported`
   shows `effective_dry_run:false`, then retest undock + trick. **DISARM after** (shadow first).
3. **Fix the honesty gap** (Moses should not claim motion in dry-run) as a separate change on
   `feat/kalhar-elevenlabs-voice`.
4. **Verify undock-on-assign** actually sends the command.

## Access + safety facts
- Pi: `ssh guidemate` (host `turtlebot-van-468`); also `ubuntu@10.247.204.21`, key
  `claude-agent-turtlebot-van-468`. Bridge is a systemd unit `guidemate-bridge.service`
  (manage with `systemctl`, never `pkill`).
- AWS: role `guidemate-agent-role` (admin), account `852373397000`, `us-west-2`, thing
  `Turtlebot-468`. Shadow get/set commands are in the runbook.
- **Shared working tree caution:** several agents commit to the same tree/branch. Use surgical
  git only: `git commit -- <exact paths> -m "..."`, never a bare `git commit`, `reset`,
  `checkout`, or broad `add` (a bare commit once swept up another agent's staged files). Commit
  messages start with `Kalhar:`, no AI/Claude references. See memory
  `multi-agent-shared-worktree-git-discipline`.
- Motion arming lives in three places (memory `motion-arming-lives-in-three-places` +
  `motion-toggle-runbook.md`). A git change alone never moves the robot; a shadow flip alone
  never moves it either.

## Plan items still open (voice)
`docs/superpowers/plans/2026-07-08-elevenlabs-voice-backend.md`: Task 6 (gated live loopback
test) and Task 7 (docs for the env switches) are not yet done. Everything else is complete.
