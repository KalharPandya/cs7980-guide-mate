# Dog Agent POC — Architecture Design

**Date:** 2026-07-05
**Status:** approved design, pre-implementation
**Scope:** demo/POC for this project (robot 468); multi-org generality is a documented
direction, not a build target.

## TL;DR
A **robot-dog emulator**: an LLM agent with a dog persona chats with users, executes motion
commands ("draw a circle"), and attaches **emotes** (short motion choreographies) to its
replies. One **Python/FastAPI container** hosts the agent loop (Strands Agents on **Bedrock
Claude Sonnet 4.6**), the chat API, an **admin panel** (feature flags + knowledge
management), and a persistent **MQTT** connection to **AWS IoT Core**. A new **agent bridge
node** on the Pi translates MQTT commands into local `cmd_vel` choreographies and enforces
safety flags via the **IoT Device Shadow**. Org knowledge comes from a **Bedrock Knowledge
Base** (S3 docs → managed RAG, S3 Vectors backend) managed from the admin UI.

## Long-term vision (design for, don't build)
The agent becomes a general-purpose organizational assistant that can dispatch robots:
"pick up the visitor at the front desk and guide them to room 468." It knows **semantic
campus locations and their map coordinates**, can see the map, and coordinates multiple
robots. The POC architecture must not block this; see [Future extensions](#future-extensions).

## Demo scope (build now)
- Dog persona chat: replies in character via Bedrock Sonnet 4.6.
- Motion commands: named primitives only ("circle", "spin", "stop").
- Emotes attached to replies: `no` = rotate CW/CCW, `yes` = forward/back nod,
  `happy` = wiggle/random motion (library is extensible).
- Staff admin panel: toggle features, kill switch, manage knowledge.
- Knowledge retrieval: dog answers org questions from uploaded documents.
- Autonomy hook: robot events (battery, bump, command completion) and schedules can
  trigger the agent without a user message.

## Components

### 1. Agent service (one Docker container — laptop now, EC2 later)
Python 3.11+, FastAPI, single asyncio process. Runs anywhere with AWS credentials;
`docker run` on a small EC2 instance (IAM instance profile) when an always-on endpoint is
needed. No code changes between the two.

| Piece | Responsibility |
|---|---|
| **Chat API** | REST + WebSocket endpoints the (out-of-scope) chat frontends call. Returns `{reply_text, emote}` per turn. |
| **Agent core** | Strands Agents loop, dog-persona system prompt, Bedrock Sonnet 4.6 via the Converse API. Tools: `send_emote(name)`, `run_motion(name, params)`, `get_status()`, `retrieve_kb(query)`. Callable from the chat API **and** from internal events (same loop, two triggers). |
| **Event layer** | One persistent MQTT-over-WebSocket connection to IoT Core (IAM/SigV4 auth — no certs on the cloud side). Subscribes to robot status; publishes commands; APScheduler for time-based behavior. Robot events become system-generated agent invocations ("battery hit 15% — decide what to do"). |
| **Feature flags** | Small local store (SQLite). Agent-tier flags checked every turn: disabled tools are simply not offered to the model. |
| **KB manager** | Admin-facing: upload documents to the KB's S3 bucket, list/delete, trigger `StartIngestionJob`, surface sync status. |
| **Admin panel** | Static single-page UI served at `/admin`; `/api/admin/*` routes behind a single admin token (demo-grade auth). Tabs: feature toggles, robot status, knowledge management. |

### 2. Feature flags — two safety tiers
- **Agent-tier** (mute dog, disable emotes, disable motion tools, persona on/off): stored in
  SQLite, enforced in the agent core. Fails "open" only as far as the agent — never reaches
  the robot.
- **Robot-tier** (`motion_enabled`, `max_speed`, emergency stop): admin sets
  `desired.*` in the **IoT Device Shadow** for `Turtlebot-468`; the bridge node reconciles,
  enforces locally (refuses motion commands), and writes `reported.*`. The kill switch
  therefore holds even if the agent service crashes, and survives robot reboots/offline
  periods (shadow semantics).

### 3. Knowledge base — Bedrock Knowledge Bases (managed RAG)
- S3 bucket of org documents → Bedrock KB managed chunking/embedding → **S3 Vectors**
  index (cheap at this scale; OpenSearch Serverless deliberately avoided on cost).
- Agent access: `retrieve_kb(query)` tool wrapping the Bedrock `Retrieve` API (Strands has
  a built-in). The agent only ever sees the tool; the backend can change without touching
  agent, admin, or robot code.
- Managed from the admin panel's knowledge tab (upload → S3 put → ingestion sync → status).
- **Rule:** exact/structured data (semantic location coordinates, config) is **never**
  vector-retrieved — that stays a structured lookup when it arrives (future scope).

### 4. Agent bridge node (new, on the Pi)
Python daemon/ROS 2 node: AWS IoT Device SDK (X.509 cert — the existing `Turtlebot-468`
identity) + rclpy.
- Subscribes to the command topic; validates messages against the shared schema; rejects
  unknown types.
- **Emote/motion choreography library:** each primitive is a local, time-bounded `cmd_vel`
  sequence with hard speed caps (≤ 0.15 m/s, matching the mapping stack convention). The
  cloud sends *names*, the Pi executes — cloud latency never touches motion control.
- Publishes acks (`received` → `done`/`failed`), battery, and events (bump, dock state) to
  the status topic.
- Reconciles Device Shadow `desired.*` safety flags; refuses motion while
  `motion_enabled=false`; reports `reported.*`.
- Namespaced-TF gotcha applies if it becomes a full ROS 2 node (remap `/tf` — CLAUDE.md
  gotcha #1). For the POC it only publishes `cmd_vel`, so TF is not required.

### 5. AWS IoT Core (existing, policy must be widened)
- Current policy is quick-start (`sdk/test/*` only). Widen to the project topics + shadow
  topics for `Turtlebot-468`, least-privilege per direction.
- QoS 1 both directions.

## Communication paths & topic design

```
user ↔ chat API            HTTP/WS         {message} → {reply_text, emote}
agent ↔ Bedrock model      Converse API    tools: send_emote, run_motion, get_status, retrieve_kb
agent ↔ Bedrock KB         Retrieve API    top-k passages
admin ↔ admin API          HTTP + token    flags, KB manage, robot status
service ↔ IoT Core         MQTT/WSS, IAM   persistent connection
robot  ↔ IoT Core          MQTT/TLS, X.509 existing device identity
service ↔ robot (shadow)   Device Shadow   desired/reported safety flags
```

**Topics** (per-robot prefix so 436 is additive):
- `guidemate/turtlebot468/cmd` — cloud → robot commands
- `guidemate/turtlebot468/status` — robot → cloud acks, battery, events
- `$aws/things/Turtlebot-468/shadow/...` — reserved shadow topics

**Command message (cloud → robot):**
```json
{"cmd_id": "uuid", "type": "emote|motion|stop", "name": "happy|yes|no|circle|spin",
 "params": {"radius": 0.5}, "ts": "iso8601"}
```
**Ack/status (robot → cloud):**
```json
{"cmd_id": "uuid", "state": "received|running|done|failed", "reason": null,
 "battery": 0.82, "ts": "iso8601"}
```
Schema is a shared Pydantic model used by both the service and the bridge (single source of
truth; the bridge vendors or pip-installs it).

## Error handling
| Failure | Behavior |
|---|---|
| Robot offline / no ack within timeout | Agent tool returns "robot unreachable"; the dog says so in character. Commands are **not** queued for offline replay in the POC (stale motion commands are a hazard, not a feature). Shadow-based flags DO persist offline by design. |
| Bedrock error / throttle | Retry with backoff (Strands default); surface a friendly failure to the user after retries. |
| MQTT disconnect (service side) | SDK auto-reconnect with backoff; event layer marks robot state "unknown" until the next status message. |
| Duplicate delivery (QoS 1) | Bridge de-duplicates by `cmd_id`; choreographies are also idempotent-safe (time-bounded, re-run ≈ same motion). |
| KB ingestion failure | Sync status surfaced in the admin knowledge tab; agent falls back to answering without retrieval. |
| Bridge crash mid-choreography | Create 3 stops on `cmd_vel` silence (no republish = no motion). Watchdog/systemd restart for the bridge. |
| Admin token wrong/missing | 401; no unauthenticated admin surface. |

## Security notes
- No credentials in the repo (existing convention). Robot keeps its X.509 identity; cloud
  side is IAM-only.
- IoT policy widened to exactly the `guidemate/turtlebot468/*` topics + this thing's shadow
  topics — not `*`.
- Admin token via environment variable; HTTPS when on EC2 (demo-grade: single token, no
  user accounts).
- The agent can only ever emit named primitives; raw velocity passthrough is deliberately
  not a command type.

## Testing strategy
- **Unit:** command schema validation (both directions), flag gating (disabled tool absent
  from the model's tool list), choreography generators (bounded speed/duration).
- **Integration, no robot:** run the bridge on a laptop against a mock `cmd_vel` sink;
  end-to-end chat → MQTT → bridge → ack with IoT Core in the loop.
- **On robot, no motion:** bridge in dry-run mode (logs instead of `cmd_vel`), verify
  shadow reconcile + acks on the real Pi.
- **On robot, motion:** docked/open-space emote test at capped speed; kill-switch drill
  (set `motion_enabled=false` mid-choreography, verify stop).
- **Persona/KB:** scripted conversation checks (emote chosen per reply, KB answer grounded
  in an uploaded doc).

## Future extensions (accommodated, not built)
- **Semantic locations:** structured table (name → map coordinates) as a new lookup tool +
  Nav2 `navigate_to_pose` command type in the bridge — never via vector retrieval.
- **See the map:** bridge uploads map snapshots to S3 (presigned URL in a status message).
- **Robot 436 / fleet:** second cert + `guidemate/turtlebot436/*` prefix; bridge is
  identical; agent core gains a robot-selection parameter.
- **Multi-org:** per-org config, KB, and topic namespace — configuration, not code.
- **Guide missions:** "pick up at front desk, lead to room X" = composition of navigate +
  wait + speak primitives; same command channel.

## Decisions log
| Decision | Choice | Rejected alternatives |
|---|---|---|
| Agent hosting | Own loop in one container, laptop → EC2 | Lambda-per-turn (no persistent MQTT, cold starts); Bedrock Agents (loop control, no live acks, Lambda per action) |
| Language/framework | Python + FastAPI | Node/NestJS (second language, weaker agent ecosystem); Go (no agent ecosystem, slower iteration) |
| Agent framework | Strands Agents | Hand-rolled Converse loop (more maintenance); LangGraph (overkill); Pydantic AI (fine, Strands is AWS-first) |
| Admin panel | Inside the FastAPI container, shadow-enforced safety flags | Separate service (extra deployable); console/CLI only (no staff demo) |
| Knowledge | Bedrock KB (S3 Vectors) + admin management UI | Curated-facts-only store (doesn't demo doc upload); local vector RAG (chosen path is the managed version of this) |
| Motion interface | Named primitives executed on-Pi | Cloud teleop / raw `cmd_vel` (latency + safety) |
