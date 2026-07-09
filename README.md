# cs7980 Moses

CS7980 Moses — a **TurtleBot 4 guide robot** that autonomously maps and navigates an
indoor space, plus **Moses**, an LLM concierge/"robot-dog" agent that chats with people
(by voice or text), answers questions from a knowledge base, and drives the robot with
safe, named motion primitives.

This single repo is both the **project documentation** (`docs/`) and a **ROS 2 colcon
workspace** (`src/`), with a cloud **agent service** (`agent_service/`) and a shared
message contract (`shared/`) on top. See [CLAUDE.md](CLAUDE.md) for the full
build/run/architecture notes and the hard-won gotchas.

---

## The two halves

| | What it is | Where |
|---|---|---|
| **Guide robot** | Autonomous SLAM mapping + Nav2 navigation, with depth-fusion glass handling. The original CS7980 work. | `src/guide_mate_explorer`, `src/guide_mate_perception` |
| **Moses (dog-agent POC)** | A Bedrock-powered concierge agent — web app + FastAPI service + on-robot bridge — that talks to people and safely commands robot 468. | `agent_service/`, `src/guide_mate_bridge`, `shared/`, `sim/` |

The guide-robot stack is documented in [CLAUDE.md](CLAUDE.md) and `docs/mapping/`. The rest
of this README covers **Moses** — the frontend (UI) and the backend (agent service + bridge).

At a high level: a browser web app talks (by voice or text) to a cloud FastAPI service,
which runs the LLM agent and relays **named motion primitives** (never raw velocities) over
AWS IoT MQTT to an on-robot bridge node. Motion is **default-deny**. A full architecture
diagram will be added here later.

---

## Frontend / UI — the concierge web app
_(source of truth: branch `sibgha/dog-agent-poc`, `agent_service/static/`)_

A single-page web app served by the FastAPI container at `/`. Branded **"Moses —
Northeastern Vancouver concierge AI"**, it opens on a landing hero ("A guide who knows the
campus…") where a visitor enters their name and starts a session, then drops into a
four-view app:

- **Chat** — the main conversation with Moses. Text **and voice**: a mic button streams
  audio to the backend, and replies come back as text plus synthesized speech, played in
  sync with an animated **avatar** that plays the reply's emote (`happy` / `yes` / `no`).
  Includes a thinking indicator, safe Markdown rendering, a sound toggle, a live status
  chip, a "request a human companion" banner, and a virtual-pet badge when the session
  isn't bound to a physical robot.
- **Wayfinding** — search buildings, rooms, and labs (semantic campus location lookup).
- **Arsenal** — shows Moses's current capabilities for *this* session (knowledge base,
  maps, human hand-off, and the robot's live safety posture: bound / dry-run /
  motion-enabled), driven by `GET /api/session/{id}/arsenal`.
- **Map** — the SLAM map PNG of the session's bound robot, streamed from S3 through the
  app's own IAM role (`GET /api/session/{id}/map`).

Layout is responsive (desktop two-pane, mobile nav rail). A separate **operator/admin
console** lives at `/admin` (see below). Assets: `index.html`, `chat.js`, `chat.css`, plus
`brand/` (Husky head mark + Northeastern Vancouver lockup).

---

## Backend — agent service + on-robot bridge
_(source of truth: branches `kalhar/dog-agent-poc` and `feat/kalhar-elevenlabs-voice`)_

### `agent_service/` — the cloud FastAPI container
A single Python/FastAPI process (laptop → EC2) that owns the LLM loop, speech, knowledge,
sessions, the admin API, and the MQTT link to the robot.

- **DogAgent** (`dog_agent.py`) — a [Strands](https://strandsagents.com) agent on
  **Bedrock Claude Sonnet** (`us.anthropic.claude-sonnet-4-6`). Persona is "Moses, the robot
  dog." Tools are **gated per-turn** by admin flags read fresh each message:
  `send_emote`, `run_motion` (tricks: `circle`, `spin`), `stop`, `get_status`, and
  `retrieve_kb`. Motion tools are **lock-gated** — only offered when the session
  physically holds the robot, so a virtual session can wag the avatar but never move a dog.
- **Chat transports** — `POST /api/chat` (request/response) and `WS /ws/chat/{session_id}`
  (voice). The WebSocket path pipelines **audio → STT → agent → emote-sync → reply + TTS
  audio**, releasing text, emote, and audio together with a time-bounded gate so a dropped
  MQTT ack can never wedge a turn.
- **Speech** (`speech.py`) — **STT** via Amazon Transcribe streaming; **TTS** via Amazon
  Polly neural (`Justin`) **or ElevenLabs** (`backend='elevenlabs'`, the
  `feat/kalhar-elevenlabs-voice` work) with an automatic Polly fallback on any error. Ships
  a pure 16-bit-PCM linear resampler for the browser mic path.
- **Knowledge** (`kb.py`) — **Bedrock Knowledge Bases** (S3 docs → managed RAG on an S3
  Vectors backend). `retrieve_kb` grounds factual answers and returns **citation sources**
  surfaced to the UI.
- **Sessions & memory** (`sessions.py`, DynamoDB) — name, last-10-message history, and the
  authoritative session→robot binding + lock. **Config store** (`store.py`, DynamoDB) holds
  admin flags + custom persona prompt.
- **Autonomy** (`autonomy.py`) — unprompted, **motion-free** turns driven by robot status
  events (e.g. low battery) and a daily scheduled "morning stretch." Autonomy turns can
  speak/emote but are hard-stopped from driving.
- **Admin / operator console** (`admin.py` + `/admin`) — single-token auth; tabs for
  **flags** (tool gating, mute, persona), **prompt**, companion **requests**, **sessions**,
  **robot** (Device-Shadow motion kill-switch + dock/undock), **knowledge** (upload/list/
  sync), **maps**, and **health** (`/healthz`, `/readyz`).
- **Deploy** — `Dockerfile`, `compose.yaml` / `compose.prod.yaml`, a `Caddyfile`, and
  `deploy/` scripts (`launch_ec2.sh`, `redeploy.sh`, `teardown.sh`).

### `src/guide_mate_bridge/` — the on-robot node
An rclpy node (systemd `guidemate-bridge.service`) that is the robot's only link to the
cloud. It subscribes the IoT `cmd` topic, **validates + dedupes** commands, executes
choreographies as a fixed-rate, abort-aware sequence of **capped `cmd_vel` twists** (with
dock/undock dispatched as Create 3 ROS **actions**, never twists), and **acks by `cmd_id`**.

Safety is layered and default-deny (`safety.py`, `shadow.py`): real wheels turn only when
`GUIDEMATE_ENABLE_MOTION=1` **and** the Device Shadow says `motion_enabled` **and** we're
not in effective dry-run **and** the robot isn't docked (while docked only `undock`/`dock`/
`stop` pass). A `stop` command or shadow kill-switch zeroes the wheels within one publish
period. `telemetry.py`/`logship.py` publish heartbeat/status and ship logs.

### `shared/guidemate_msgs/` — the contract
Shared Python package used by **both** the cloud service and the bridge: the `Command` /
`Ack` message models, IoT topic helpers, the **choreography** primitives (with `MAX_LINEAR`
caps), structured JSON logging, and metrics — so cloud and robot agree byte-for-byte on the
wire format and the motion limits.

### `sim/` — TurtleBot 4 Ignition simulator
Bring-up notes + launch scripts to exercise the bridge against a simulated robot
(un-namespaced `/cmd_vel`, `/dock_status`, etc.) instead of the physical dog — the safe way
to test motion choreographies. See [sim/README.md](sim/README.md).

---

## Running it

```bash
# ROS 2 workspace (guide robot + bridge)
cd ~/cs7980-guide-mate && colcon build --symlink-install
source install/setup.bash

# Agent service — local dev (offline, no robot/AWS): fake robot + tests
cd agent_service
GUIDEMATE_FAKE_ROBOT=1 uvicorn guidemate_agent.app:app --reload   # http://localhost:8000
pytest                                                            # unit + integration + e2e

# Agent service — container
docker compose up            # compose.yaml (dev) / compose.prod.yaml (EC2)
```

Key env vars (`agent_service/guidemate_agent/config.py`): `GUIDEMATE_ROBOTS`,
`GUIDEMATE_IOT_ENDPOINT`, `GUIDEMATE_MODEL_ID`, `GUIDEMATE_KB_ID`, `AWS_REGION`,
`GUIDEMATE_FAKE_ROBOT=1` (offline). No credentials live in the repo — see the security note
in [docs/README.md](docs/README.md).

> ⚠️ **Robot safety:** robot 468 is docked and unobserved. Motion is **default-deny** and
> requires a human observer + explicit opt-in. See [CLAUDE.md](CLAUDE.md) and
> `docs/agent-poc/motion-toggle-runbook.md` before enabling any motion.

---

## Repo layout

```
cs7980-guide-mate/
├── agent_service/        # Moses cloud service: FastAPI agent, speech, KB, admin, static UI
│   ├── guidemate_agent/  #   app, dog_agent, ws_chat, speech, kb, sessions, admin, autonomy…
│   ├── static/           #   concierge web app (index/chat.*) + /admin console + brand assets
│   └── deploy/           #   Docker + EC2 deploy scripts
├── src/
│   ├── guide_mate_explorer/    # Python: BFS frontier mapping, glass_guard, depth_lidar_fusion
│   ├── guide_mate_perception/  # C++: ~10× cheaper rclcpp port of the fusion node
│   └── guide_mate_bridge/      # rclpy on-robot node: IoT cmd → capped cmd_vel, acks, safety
├── shared/guidemate_msgs/# shared Command/Ack + choreography + logging/metrics contract
├── sim/                  # TurtleBot 4 Ignition simulator bring-up for bridge testing
└── docs/                 # working docs (mapping/, agent-poc/, aws-iot/, network/, camera.md…)
```

---

## Documentation

See [docs/README.md](docs/README.md) for the full index. Highlights:

**Moses (dog-agent POC)**

- [Session handoff & full context](docs/agent-poc/HANDOFF-2026-07-05.md) — mission, all
  architecture decisions, access summary, safety rules, state of work (read this first)
- [Access ground truth](docs/agent-poc/access-ground-truth.md) — verified access /
  permissions / credentials + the AWS resource inventory (IoT policy, shadow, KB ids)
- [Design scope](docs/agent-poc/dog-agent-design-scope.md) and the approved design +
  implementation specs under `docs/superpowers/specs/`
- [Motion-toggle runbook](docs/agent-poc/motion-toggle-runbook.md) — how to safely
  arm/disarm supervised robot 468 motion
- [Linux agent warm-up](docs/agent-poc/linux-agent-warmup.md) — new machine/session
  onboarding (credential-file paths + a ready-to-paste warm-up prompt)
- [TurtleBot 4 Ignition sim](sim/README.md) — bring-up + probe notes for testing the bridge

**Guide robot (mapping & navigation)**

- [Autonomous mapping](docs/mapping/README.md) — BFS explorer + SLAM + Nav2, glass handling,
  how to run
- [Depth camera for mapping](docs/mapping/depth-perception.md) — using OAK-D depth to see the
  glass the lidar can't (FOV, height-filtered pipeline, planned lidar-scan injection)
- [OAK-D-LITE camera](docs/camera.md) — depth/RGB camera test: both streams work on USB 2,
  the USB 3 boot-loop root-caused to power, and the bandwidth-limited frame drops
- [Power](docs/power.md) — idle draw, why soft "park" services don't cut power, and the
  working park (kill the processes)

**Network / AWS**

- [Network overview](docs/network/README.md) — two-computer architecture, discovery
  model, addressing, time sync
- [Connecting to NUwave](docs/network/nuwave-connection.md) — step-by-step, including
  the 5 GHz regulatory-domain fix
- [ROS 2 over NUwave](docs/network/ros2-over-nuwave.md) — what works / what doesn't,
  the four root causes, and the working laptop setup
- [AWS IoT Core](docs/aws-iot/README.md) — thing/policy setup, service integration, and
  secure tunneling for remote access to robot 468
