# Dog Agent POC — Implementation Design (self-driven, no-motion)

**Date:** 2026-07-05
**Status:** approved design, pre-plan
**Parent:** [2026-07-05-dog-agent-architecture-design.md](2026-07-05-dog-agent-architecture-design.md) —
the architecture is settled there; this spec covers *how it gets built, deployed, and
tested autonomously*, plus the scope deltas approved 2026-07-05 (evening).

## TL;DR
Fully autonomous end-to-end build from the Linux box: vertical slice first (chat → agent →
MQTT → bridge dry-run on the Pi → ack), then widen phase by phase to KB + admin panel,
**multi-user sessions with an admin-approved physical-companion flow** (open chat for all,
one robot-connected session at a time), Transcribe/Polly voice chat with synced emotes, an
S3 maps tab, and a scripted production deployment on **EC2 t3.large** behind Caddy
auto-TLS (`<eip>.nip.io`). Everything is tested
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
| Multi-user sessions | **In scope** (added 2026-07-05, late): open/free chat for all users; per-session intake (name + "comfortable around Physical AI Dogs?"); session id + intake in browser localStorage; **Start new session** button clears it. Agent knows the user's name. |
| Physical-companion flow | **In scope**: user requests a physical companion from the chat UI → pending request in the admin panel → admin approves → that session is bound to the robot. **Exactly one robot-connected session at a time.** Admin can abort the ongoing robot session, or approve another request (aborting the current one). Non-connected sessions get *virtual* emotes (avatar animation only); the connected session also drives the physical robot. |
| Session store | **DynamoDB** (chosen 2026-07-05, supersedes the earlier SQLite choice — Kalhar wants data readable in the AWS console): 4 small on-demand tables — `guidemate-sessions`, `guidemate-messages`, `guidemate-requests`, `guidemate-config` (flags + admin-set prompts + robot locks). Console-browsable, ~$0 at POC scale, survives instance rebuilds; the per-robot session lock is an **atomic conditional write**. Intake info used only for personalization + approval context. Admin can browse all chat histories. |
| Admin robot commands | Admin can send direct robot commands (`dock`, `stop`, primitives) from the panel — same command channel, **same bridge safety locks** (dock/undock are motion → refused while `motion_enabled=false`; verified via dry-run/refusal paths only in this plan). |
| Assignment-triggered dock/undock | **In scope** (added 2026-07-05, late): when admin approves a session→robot binding the service publishes motion **`undock`** (robot gets ready); on unassign (abort/reassign/release) it publishes motion **`dock`** (best-effort). New motion names `undock`/`dock` in the shared schema; on the bridge they map to **Create 3 dock/undock ROS actions** (not `cmd_vel`), behind the same safety gates. **Dock-guard exemption:** `undock` (and `dock`, and `stop`) are allowed while docked; all other motion stays refused. On robot 468 these are dry-run/refusal-verified only (locks untouched); real dock/undock motion is validated in the Phase 8 sim. Cloud-side hooks land in Phase 4; bridge action execution in Phase 8. |
| Admin auth | **Password → session cookie** (upgrades the architecture spec's bearer token): admin password from an env var (generated at deploy) posted to a login form → signed **HttpOnly Secure SameSite=Strict** cookie; rides every API call and WebSocket automatically, unreadable to page JS. Timing-safe compare + attempt rate-limit. Still single-credential, no user accounts. |
| Multi-robot agent core | **First-class from day one** (goal directive): the agent service holds a **robot registry** (`robot_id` → MQTT topics, link state, latest status) over one shared IoT connection (wildcard `guidemate/+/status` subscribe). Agent tools take/receive a robot binding; a session can be bound to **one or more robots**; admin assigns/revokes per robot. POC exercises two (468 + sim); the registry and schema impose no upper bound, so multi-robot-per-user and AI coordination of several robots are configuration, not rework. |
| Admin-set agent prompts | Admin panel can **edit the dog's system prompt / behavior directives** (stored in DynamoDB `guidemate-config` alongside flags, applied on the next turn); the agent must demonstrably follow the admin-set prompt. |
| Gazebo sim / virtual pets | **In scope, after the robot path is green** (robot first — phases 0–7 unchanged). This box already has the full TB4 Ignition Fortress sim stack + GPU. New **Phase 8**: sim IoT identity (`Turtlebot-Sim` thing + cert + own shadow + `guidemate/turtlebotsim/*` policy), the same bridge pointed at the sim's ROS graph, **motion validation** (`motion_enabled=true` on the *sim shadow only*: odometry-verified choreographies, kill-switch drill, dock-guard fire) + headless pytest regression, and the companion flow gains a **virtual pet** grant: sessions that don't hold the physical-robot lock can be connected to the sim robot instead. One sim robot in this plan; multi-spawn per-user pets = documented follow-on. To keep Phase 8 a params-only drop-in, the bridge and agent service are **parameterized from day one** (thing name, namespace, topic prefix / robot registry) — robot 468's locks are never touched by any sim work. |

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
6. **App store (DynamoDB, on-demand)** — tables `guidemate-sessions`, `guidemate-messages`,
   `guidemate-requests`, `guidemate-config`: agent-tier feature flags + admin-set prompts
   (checked every turn), sessions, intake answers, chat history, companion requests, and
   per-robot session locks (atomic conditional writes). All console-browsable.
7. **KB manager** — upload → S3 → `StartIngestionJob` → sync status (KB `A1NIQYZ0KQ`,
   data source `OT8JLH57TE`).
8. **Speech backend** — Transcribe streaming (mic→text) + Polly neural (dog voice out).
9. **Chat UI (`/`)** — intake screen (name + comfort question) on first visit; dog
   avatar, bubbles over WS, mic button, audio playback, battery/dock/motion-lock status
   chip, emote indicator (virtual for everyone; physical too when robot-connected);
   **Request physical companion** button with request-state banner
   (pending/approved/denied/aborted); **Start new session** (clears localStorage).
10. **Admin UI (`/admin`)** — password login → signed HttpOnly session cookie; tabs: agent flags, robot-tier flags +
    kill switch (writes Device Shadow), live robot status, KB manage, **Maps**,
    **Requests** (pending companion requests with intake context → approve/deny),
    **Sessions** (all users' chat histories, read-only), **Robot session** (who's
    connected, abort, reassign, direct commands like `dock`/`stop`).
11. **Dockerfile + compose** — app + Caddy; identical artifact locally and on EC2;
    containers log via the `awslogs` driver to CloudWatch.

**`src/guide_mate_bridge/`** (Pi; additive)
12. **Bridge node** — AWS IoT Device SDK (existing `Turtlebot-468` X.509 cert, client id
    `guidemate-*` per policy) + rclpy; validates commands against the schema; dedupes by
    `cmd_id`. **Parameterized identity** (thing name, cert paths, ROS namespace, topic
    prefix) so the identical code serves robot 468, the Gazebo sim (`Turtlebot-Sim`,
    Phase 8), and later 436.
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

**Sessions & companion flow** (in `agent_service/`)
25. **Session layer** — anonymous session id (UUID) minted at intake (name + comfort
    question), mirrored in localStorage; server-side record in DynamoDB; the agent's
    system context includes the user's name; **Start new session** clears localStorage
    and mints a fresh id (old record kept server-side for admin history).
26. **Companion request flow** — chat-UI request → `pending` row (with intake context)
    → admin approve/deny → on approve, the session acquires the **robot lock** (single
    holder; enforced server-side). Robot tools (`send_emote` physical path,
    `run_motion`) are offered to the model **only** for the lock-holding session;
    everyone else stays virtual-emote-only.
27. **Admin robot-session controls** — abort the ongoing robot session (releases the
    lock, notifies that user's UI); approve a different request (aborts current, then
    binds the new session); direct commands (`dock`, `stop`, any primitive) published on
    the same `/cmd` channel — subject to the bridge's full safety layer like any other
    command (dock/undock = motion → refused while locked; dry-run/refusal verification
    only in this plan).
28. **Chat-history viewer** — admin Sessions tab lists all sessions (name, intake
    answers, timestamps, robot-connected badge) with read-only transcripts.

**Sim / virtual pets (Phase 8 — after the robot path is green)**
29. **Sim identity + launch helper** — one-time script: thing `Turtlebot-Sim`, fresh
    cert, `guidemate/turtlebotsim/*`-scoped policy, own shadow (default
    `motion_enabled=false`, flipped true only during sim motion runs); `sim/` launch
    helper bringing up the TB4 Ignition world + the bridge with sim params.
30. **Sim motion validation** — odometry-asserted choreographies (circle closes, wiggle
    nets ~zero), kill-switch drill mid-choreography, dock-guard fire on the simulated
    dock; headless (`ign gazebo -s`) pytest variant kept as the standing regression
    suite. Closes the motion-proof gap without touching robot 468.
31. **Virtual-pet grant** — companion flow extension: admin can connect a non-lock
    session to the sim robot (`robot_id=turtlebotsim`) as a **virtual pet**; same
    tools, same UI, physical lock untouched. Single sim robot in this plan; per-user
    multi-spawn is the documented follow-on.

## Build phases (vertical slice → widen)
Riskiest integrations are proven first; every phase ends green before the next starts.

| Phase | Builds | Exit test (all no-motion) |
|---|---|---|
| **0 — Foundations** | Components 1–2 + test harness | Kinematic unit tests pass; trajectory PNGs visually correct |
| **1 — The slice** | Minimal agent (persona + `send_emote`) → REST chat → MQTT → bridge on Pi (systemd, `dry_run=true`) → plain chat page | curl "do a happy wiggle" → dog reply + Pi log shows computed `cmd_vel` sequence + `"simulated": true` ack round-trip. Checklist items **1, 3** |
| **2 — Robot truth** | Telemetry (15), shadow reconcile + dock guard (14), `get_status`/`run_motion`/`stop` tools | Battery/dock visible via `/status`; `desired→reported` reconciles and survives bridge restart; refusal paths (`docked`, `motion_disabled`) verified. Checklist items **2, 4, 5** |
| **3 — Knowledge + admin base** | Components 6 (flags part), 7, 10 (flags/status/KB tabs) | Flag flip removes tool mid-session; KB answer grounded in uploaded doc; kill switch flips shadow |
| **4 — Sessions + companion flow** | Components 6 (sessions part), 25–28 + UI intake/request states | Two Playwright browsers: A requests, admin approves → A drives (dry-run) emotes while B stays virtual; admin reassigns to B → A's UI shows aborted, B drives; admin `dock` command refused (`motion_disabled`) — lock exclusivity + refusal proven |
| **5 — Voice + UI polish** | Components 8, 9 + emote sync; polish admin | Playwright fake-mic e2e: voice in → transcript → reply + synced emote ack → Polly audio out |
| **6 — Autonomy + maps** | Autonomy hook (events + APScheduler) + component 24 | Synthetic low-battery event triggers an unprompted agent turn (checklist item **6**); map renders in admin |
| **7 — Production** | Components 11, 17–19 | Full Playwright suite green against `https://<eip>.nip.io`; one URL for chat, one for admin |
| **8 — Sim / virtual pets** (after robot path green) | Components 29–31 | Sim bridge connects under its own identity; choreographies odometry-verified + kill-switch drill pass (sim shadow only); admin grants a virtual pet to a second session while the physical lock is untouched |

## Testing strategy
| Layer | Tool | Robot needed? |
|---|---|---|
| Schema, choreography kinematics, flag gating | pytest | no |
| Agent loop (mocked Bedrock + one live smoke) | pytest | no |
| Bridge logic | pytest with fake MQTT + fake rclpy; then real IoT Core from the Linux box | no |
| E2E chain | real service ↔ IoT Core ↔ real bridge on the Pi, dry-run | docked, zero motion |
| UI + speech | Playwright + fake-mic WAV (Polly-synthesized) | docked (emote acks simulated) |
| Sessions / companion flow | Playwright multi-browser (user A + user B + admin): request → approve → exclusivity → abort/reassign → localStorage reset | docked (dry-run) |
| Production | same Playwright suite vs the nip.io URL | docked |

**Three independent motion locks** stand throughout: shadow `motion_enabled=false`
(default-deny, missing shadow = false), dock guard, and `dry_run=true`. None are touched
by this plan. **Out of scope:** physical-motion validation (observed session later);
BFS explorer / fusion / SLAM (parked); robot 436; multi-org.

## Observability (cross-cutting; approved 2026-07-05, late)
Built in from the first line of code, not bolted on. Everything lands in **CloudWatch**
(console-readable, matching the DynamoDB choice).

**Core (unconditional):**
1. **Correlation IDs end-to-end** — every chat turn gets a `turn_id`, carried through
   agent → tool call → MQTT `cmd_id` → bridge log → ack → UI. One Logs Insights query
   reconstructs any interaction. Shared JSON-logging helper lives in
   `shared/guidemate_msgs` (used by service *and* bridge) from Phase 0.
2. **Structured JSON logs → CloudWatch** — service containers via the Docker `awslogs`
   driver (`/guidemate/agent-service`); every line carries
   `turn_id`/`cmd_id`/`session_id`/`robot_id`.
3. **Metrics via EMF** (metrics are just log lines; zero infra) — turn latency, Bedrock
   latency/tokens/cost-per-turn, KB retrieval latency, MQTT ack round-trip per robot,
   Transcribe/Polly latency, WS connections, error counts.
4. **IoT Core logging + presence** — IoT logging enabled (surfaces policy denials);
   bridge sets an **MQTT Last Will** so a dropped Pi instantly publishes `offline` to
   its status topic; console MQTT test client for live topic watching.
5. **Health endpoints + heartbeats** — service `/healthz` + `/readyz` (MQTT? DynamoDB?
   creds?); bridge heartbeats every 30 s (battery/dock/uptime) — closes the
   silent-wedge blind spot (gotcha #8).
6. **Dashboard + alarms** — CloudWatch dashboard `guidemate-poc` (service health, robot
   presence, ack latency, tokens/cost, errors) + 4 alarms (service unhealthy, bridge
   offline >5 min, Bedrock throttling, EC2 CPU). No SNS/email (declined).
7. **Admin Health tab** — robot link state + last heartbeat, last 10 commands with ack
   timings, recent errors, per-turn cost.
8. **Dev-time** — Playwright traces/videos on failure kept as artifacts; integration
   tests log with the same correlation IDs as production.

**Extras (approved):** **Bedrock model-invocation logging** (full request/response →
CloudWatch/S3 — audit + prompt debugging); **CloudWatch agent on the Pi** (journald →
same log groups; watch the CPU cost on the compute-tight Pi); **CloudWatch agent on
EC2** (system metrics + Caddy access logs, alongside the container `awslogs` driver).

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
