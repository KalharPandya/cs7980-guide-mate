# Dog Agent POC — Implementation Design (self-driven, no-motion)

**Date:** 2026-07-05
**Status:** approved design, pre-plan
**Parent:** [2026-07-05-dog-agent-architecture-design.md](2026-07-05-dog-agent-architecture-design.md) —
the architecture is settled there; this spec covers *how it gets built, deployed, and
tested autonomously*, plus the scope deltas approved 2026-07-05 (evening).

## TL;DR
Fully autonomous end-to-end build from the Linux box: vertical slice first (chat → agent →
MQTT → bridge dry-run on the Pi → ack), then widen phase by phase to KB + admin panel,
Transcribe/Polly voice chat with synced emotes, an S3 maps tab, and a scripted production
deployment on **EC2 t3.large** behind Caddy auto-TLS (`<eip>.nip.io`). Everything is tested
with the robot **docked and motion-locked** (dry-run + shadow `motion_enabled=false` + dock
guard — three independent locks). Physical-motion validation is explicitly out of scope.

## Scope deltas vs the architecture spec (all approved by Kalhar)
| Delta | Decision |
|---|---|
| Execution mode | **Fully autonomous**: implement, deploy (Pi + AWS + EC2), test, commit per phase; stop only if genuinely blocked. |
| Chat frontend | **In scope** (was out): polished web chat at `/` in the same container. |
| Speech | **In scope**: speech-to-speech via **Amazon Transcribe streaming (STT) + Polly neural (TTS)**. |
| Emote sync | Reply text/audio released when the bridge acks `running` for the emote (~2 s timeout fallback) — voice, text, and wiggle land together. |
| Hosting | Local dev on the Linux box (venv + Docker) → **scripted, repeatable EC2 deploy**; **t3.large** (optimize later). |
| HTTPS | Caddy reverse proxy, auto-TLS via Let's Encrypt on a free `<elastic-ip>.nip.io` hostname (mic requires a secure origin). Nothing needed from the user. |
| Maps | **Static S3 maps tab in scope**: upload the last saved map from the Pi to S3, render in an admin Maps tab; wired so live snapshots plug in when mapping resumes. |
| Mapping stack | **BFS explorer / depth fusion / SLAM are parked.** The bridge depends only on base bringup (Create 3 battery/dock topics + `cmd_vel` sink). |

## Network topology (governs all verification)
The Linux box has **tunneled, one-way** access to NUwave: SSH out to the Pi works; nothing
robot-initiated reaches the box, and DDS/ROS traffic does not traverse (no remote
`ros2 topic echo` — a documented dead-end). The architecture already fits: **both** the
agent service and the bridge dial *outbound* to AWS IoT Core, which is the only live
runtime channel.

```
[Linux box] ──SSH (outbound, tunneled)──────────▶ [Pi / robot 468 on NUwave]
     │        (no reverse path, no DDS)                │
     └──────▶ [AWS IoT Core us-west-2] ◀───────────────┘
              both sides connect outbound (MQTT)
                        ▲
              [EC2 t3.large — production]
```

**Robot-truth priority order:** ① MQTT `/status` messages (hearable from anywhere),
② `ssh … journalctl -u guidemate-bridge` (log pull), ③ assign the on-Pi Claude Code a
focused check task (ROS-graph questions only; subscription-limited, use sparingly).

## Access-point usage
| Access point | Used for | Creates |
|---|---|---|
| Linux box | All authoring, pytest, Playwright/Chrome (real display), Docker builds, dev service, AWS CLI | All source + tests + deploy scripts |
| SSH → Pi | Deploy via `git pull` on the Pi (repo = transport), venv install, systemd unit, logs. **Additive only** — existing bringup untouched; never `pkill -f` | Installed bridge + `guidemate-bridge.service` |
| On-Pi Claude (`claude -p`) | Robot-side verification/debug needing the robot's own ROS context | Labor, not artifacts |
| AWS IoT Core | Runtime channel: `guidemate/turtlebot468/{cmd,status}` + Device Shadow (policy + shadow already exist ✅) | — |
| Bedrock | Sonnet 4.6 turns, KB `A1NIQYZ0KQ`, Transcribe, Polly | KB docs via admin uploads |
| EC2 | Production host (instance profile `guidemate-agent-profile`, zero-credential) | Instance + EIP + SG, tagged `guidemate-poc` |

## Repo layout
```
cs7980-guide-mate/
├── agent_service/            # NEW — cloud side (own Python project, not a ROS pkg)
│   ├── guidemate_agent/      #   FastAPI: agent core, chat API+WS, admin API,
│   │   ...                   #   MQTT event layer, KB manager, speech
│   ├── static/               #   chat UI (/) + admin UI (/admin)
│   ├── tests/
│   ├── Dockerfile, compose.yaml, pyproject.toml
│   └── deploy/               #   EC2 launch script, user-data, Caddyfile
├── shared/guidemate_msgs/    # NEW — Pydantic cmd/ack schema + choreography library
└── src/guide_mate_bridge/    # NEW — ament_python ROS 2 pkg for the Pi
```

## Component inventory
**`shared/guidemate_msgs/`**
1. **Command/ack schema** — Pydantic models for `cmd`, `ack/status`, `event`; single
   source of truth for both sides (service pip-installs; Pi vendors via repo checkout).
2. **Choreography library** — named primitives (`happy`, `yes`, `no`, `circle`, `spin`,
   `stop`) → time-bounded `(twist, duration)` sequences, hard-capped ≤ 0.15 m/s.

**`agent_service/`**
3. **Agent core** — Strands loop, dog persona, Bedrock `us.anthropic.claude-sonnet-4-6`;
   tools `send_emote` / `run_motion` / `get_status` / `retrieve_kb`, each flag-gated.
4. **Chat API** — REST + WebSocket; returns `{reply_text, emote}`; emote-sync gating.
5. **Event layer** — persistent MQTT-over-WSS (IAM/SigV4); subscribes `/status`, publishes
   `/cmd`; robot events + APScheduler trigger agent turns without a user message.
6. **Feature-flag store** — SQLite; agent-tier flags (mute, emotes off, motion tools off,
   persona off) checked every turn.
7. **KB manager** — upload → S3 → `StartIngestionJob` → sync status (KB `A1NIQYZ0KQ`,
   data source `OT8JLH57TE`).
8. **Speech backend** — Transcribe streaming (mic→text) + Polly neural (dog voice out).
9. **Chat UI (`/`)** — dog avatar, bubbles over WS, mic button, audio playback,
   battery/dock/motion-lock status chip, emote indicator.
10. **Admin UI (`/admin`)** — single-token auth; tabs: agent flags, robot-tier flags +
    kill switch (writes Device Shadow), live robot status, KB manage, **Maps**.
11. **Dockerfile + compose** — app + Caddy; identical artifact locally and on EC2.

**`src/guide_mate_bridge/`** (Pi; additive)
12. **Bridge node** — AWS IoT Device SDK (existing `Turtlebot-468` X.509 cert, client id
    `guidemate-*` per policy) + rclpy; validates commands against the schema; dedupes by
    `cmd_id`.
13. **Choreography executor** — primitives as `cmd_vel` sequences; **dry-run mode**
    computes + logs the exact sequence, publishes nothing, acks `"simulated": true`.
14. **Safety layer** — shadow reconcile (`motion_enabled`/`max_speed`/`dry_run`),
    dock guard, default-deny (missing/unreadable shadow = locked).
15. **Telemetry** — battery, dock state, bump events → `/status` (also feeds the admin
    panel and closes the "can't hear the robot" gap).
16. **systemd unit + installer** — `guidemate-bridge.service`, idempotent install script
    run over SSH.

**`agent_service/deploy/`**
17. **EC2 launch script** — t3.large, `guidemate-agent-profile`, Elastic IP, SG 80/443,
    tag `guidemate-poc`.
18. **Bootstrap user-data** — installs Docker, pulls repo, `compose up`.
19. **Caddyfile** — auto-TLS on `<eip>.nip.io`, reverse proxy to the app.

**Tests**
20. **Unit** — schema round-trips; choreography kinematics (trajectory closure, speed
    caps, PNG plots of the would-be path); flag gating (disabled tool absent from the
    model's tool list).
21. **Integration** — agent loop vs mocked Bedrock + one live smoke; bridge vs fake
    MQTT/fake rclpy; real IoT Core round-trip from the Linux box.
22. **E2E** — Playwright UI + fake-mic speech loopback (Polly-synthesized "user voice" →
    Transcribe → agent → Polly out, via Chrome `--use-fake-device-for-media-stream`);
    dry-run robot chain; the same suite re-run against the production URL.

**Docs**
23. **Spec, runbook, AWS inventory** — this spec; start/stop/kill-switch/troubleshooting
    runbook; `access-ground-truth.md` updated with every new AWS resource.

**Maps**
24. **S3 maps tab** — install step uploads the Pi's last saved map (PNG + timestamp) to
    S3; admin Maps tab renders it; upload path designed so live snapshots plug in later.

## Build phases (vertical slice → widen)
Riskiest integrations are proven first; every phase ends green before the next starts.

| Phase | Builds | Exit test (all no-motion) |
|---|---|---|
| **0 — Foundations** | Components 1–2 + test harness | Kinematic unit tests pass; trajectory PNGs visually correct |
| **1 — The slice** | Minimal agent (persona + `send_emote`) → REST chat → MQTT → bridge on Pi (systemd, `dry_run=true`) → plain chat page | curl "do a happy wiggle" → dog reply + Pi log shows computed `cmd_vel` sequence + `"simulated": true` ack round-trip. Checklist items **1, 3** |
| **2 — Robot truth** | Telemetry (15), shadow reconcile + dock guard (14), `get_status`/`run_motion`/`stop` tools | Battery/dock visible via `/status`; `desired→reported` reconciles and survives bridge restart; refusal paths (`docked`, `motion_disabled`) verified. Checklist items **2, 4, 5** |
| **3 — Knowledge + admin** | Components 6, 7, 10 (flags/status/KB tabs) | Flag flip removes tool mid-session; KB answer grounded in uploaded doc; kill switch flips shadow |
| **4 — Voice + UI** | Components 8, 9 + emote sync; polish admin | Playwright fake-mic e2e: voice in → transcript → reply + synced emote ack → Polly audio out |
| **5 — Autonomy + maps** | Autonomy hook (events + APScheduler) + component 24 | Synthetic low-battery event triggers an unprompted agent turn (checklist item **6**); map renders in admin |
| **6 — Production** | Components 11, 17–19 | Full Playwright suite green against `https://<eip>.nip.io`; one URL for chat, one for admin |

## Testing strategy
| Layer | Tool | Robot needed? |
|---|---|---|
| Schema, choreography kinematics, flag gating | pytest | no |
| Agent loop (mocked Bedrock + one live smoke) | pytest | no |
| Bridge logic | pytest with fake MQTT + fake rclpy; then real IoT Core from the Linux box | no |
| E2E chain | real service ↔ IoT Core ↔ real bridge on the Pi, dry-run | docked, zero motion |
| UI + speech | Playwright + fake-mic WAV (Polly-synthesized) | docked (emote acks simulated) |
| Production | same Playwright suite vs the nip.io URL | docked |

**Three independent motion locks** stand throughout: shadow `motion_enabled=false`
(default-deny, missing shadow = false), dock guard, and `dry_run=true`. None are touched
by this plan. **Out of scope:** physical-motion validation (observed session later);
BFS explorer / fusion / SLAM (parked); robot 436; multi-org.

## Execution rules
- TDD per phase; commit + push per phase with **"Kalhar"** in the message, never any
  AI co-author reference; `git pull` at session start (multi-session convention).
- On-Pi work over SSH is **additive only**; kill by PID, never `pkill -f` (gotcha #6);
  no changes to existing bringup, services, or configs without explicit need.
- Every AWS resource created: tagged `guidemate-poc`, documented in
  `docs/agent-poc/access-ground-truth.md` (sandbox is rebuildable from the repo).
- No credentials in the repo (existing convention).
- Stop-and-ask only when genuinely blocked (e.g. EC2 guardrail denies launch —
  fallback: run the production compose on the Linux box, same artifacts).

## Environment facts (verified 2026-07-05 on the Linux box)
- AWS CLI v2.35.15 (`~/.local/bin`), identity `guidemate-agent-role` via X.509
  `credential_process`; Bedrock converse, IoT, shadow, KB retrieve all verified.
- SSH `guidemate` → Pi verified (fingerprints matched docs); passwordless sudo on both.
- Docker 29.1.3 + Compose v2 installed (user in `docker` group); Google Chrome + real
  display for Playwright; on-Pi Claude Code relay verified (`READY`).

## Cost note
t3.large ≈ $2/day (sandbox; optimize later), Transcribe ≈ $0.024/min of speech, Polly
neural pennies, Sonnet 4.6 per-token — negligible at demo scale.
