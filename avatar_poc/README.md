# Live Avatar POC (Option A)

A standalone proof-of-concept for the dog agent's **on-screen avatar**: a 2D SVG dog
that **lip-syncs to Amazon Polly** and plays the **same emote vocabulary the physical
robot uses**. It proves the one novel piece of the live-avatar design; it does **not**
touch the robot, IoT, Bedrock, or the KB.

See the design context in [../docs/agent-poc/](../docs/agent-poc/) and the
[architecture spec](../docs/superpowers/specs/2026-07-05-dog-agent-architecture-design.md).

## What it shows
- Type text → the dog speaks it in a Polly voice, with the **mouth driven by Polly
  viseme speech-marks** (millisecond-timed mouth shapes), synced to audio playback.
- Emote buttons (`happy`, `yes`, `no`, `circle`, `spin`) play the on-screen animation —
  the same names the robot bridge node will execute as motion. One vocabulary, two bodies.
- Ambient life: idle tail wag, blinking, breathing.

## Architecture
```
browser  ──POST /api/say {text, emote, voice}──►  FastAPI (app.py)
                                                     │  Amazon Polly (us-west-2)
                                                     │   • mp3 audio
                                                     │   • viseme speech-marks
        ◄──{audio_b64, visemes[], emote}────────────┘
  play audio + snap mouth per viseme + play emote animation
```
- `app.py` — FastAPI: `/api/say` (Polly synth), `/api/health`, serves the static UI.
- `static/index.html` — inline SVG dog (id'd parts) + controls.
- `static/avatar.js` — viseme→mouth map, audio-synced lip-sync, emote animations.
- `static/styles.css` — styling.

AWS credentials come from the default profile (cert-based `guidemate-agent-role` via
`credential_process`; see `docs/agent-poc/access-ground-truth.md`). No secrets here.

## Run it
```bash
cd avatar_poc
pip install -r requirements.txt          # or into a venv (see below)
python -m uvicorn app:app --port 8100
# open http://localhost:8100
```
Health check: `curl http://localhost:8100/api/health` → `{"status":"ok","polly":true,...}`.

**Optional venv** (isolation): `python -m venv .venv` then `source .venv/bin/activate`
(Windows: `.venv\Scripts\activate`), then `pip install -r requirements.txt`. `.venv/` is
gitignored, so every fresh checkout must create/populate it.

**Preview/launch note:** `.claude/launch.json` (used by the preview tooling) runs
`python -m uvicorn …`, i.e. whatever `python` resolves to on PATH — so the three
requirements must be importable by that interpreter (global install, or an activated venv
before launching). On distros where only `python3` exists, run the manual command with
`python3` (or point the launch config at your venv's interpreter).

## Notes / decisions
- **Engine = `neural`** for both audio and visemes so their timing is guaranteed aligned
  (the generative engine gives a nicer voice but does not emit viseme marks — mixing the
  two would desync the mouth). Voice defaults to `Ivy` (playful child voice).
- Mouth is a single ellipse snapped per viseme — cheap and reads as talking; no rigging.
- This is the avatar slice only. Wiring it to the real agent (`{reply_text, emote}` from
  Bedrock) and to the robot (same emote over MQTT) is the integration step, out of scope
  for this POC.
