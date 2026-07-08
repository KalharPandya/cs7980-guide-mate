# Dog Agent POC - Design Scope

**Date:** 2026-07-06
**Status:** product/UX scope for the current dog-agent POC
**Source specs:** [architecture](../superpowers/specs/2026-07-05-dog-agent-architecture-design.md),
[implementation](../superpowers/specs/2026-07-05-dog-agent-implementation-design.md),
[handoff](HANDOFF-2026-07-05.md)

## TL;DR
Echo is a mobile-first robot-dog companion for the CS7980 Guide-Mate project. Students and
visitors can chat with Echo, see a virtual dog emote with every reply, ask project or lab
questions grounded in the Bedrock Knowledge Base, and request a physical companion session.
Staff use an admin console to approve physical access, monitor robot safety state, manage
knowledge, inspect sessions, and fire one-way safety controls.

The design goal is **friendly chat for users, sober control for staff**. The user surface
should feel like a companion. The admin surface should feel like an operations panel.

## Product Positioning
The robot's product-facing name is **Echo**: a responding doggo that echoes back helpful
answers, actions, and feedback. The name intentionally nods to Amazon Echo while keeping
the POC framed as a small robot-dog companion rather than a voice assistant clone.

Echo is not a free-driving teleop robot and not a general campus guide yet. For this POC,
Echo is:

- A dog-persona LLM agent backed by Bedrock Sonnet.
- A chat companion that can play virtual emotes for everyone.
- A physical robot companion only after admin approval.
- A named-command robot interface: emotes, `circle`, `spin`, `stop`, `dock`, `undock`.
- A knowledge helper grounded in uploaded Guide-Mate documents.
- A safety-first demo: motion locked by default, dry-run supported, dock guard enforced.

## Primary Users
| User | Goal | Design implication |
|---|---|---|
| Visitor/student | Talk with Echo and understand the project quickly | Minimal intake, chat first, visible dog state, no robotics jargon |
| Approved companion user | Interact with the physical robot safely | Clear approval state, physical/virtual distinction, status chips |
| Staff/admin | Keep robot safe and manage access | Dense controls, explicit refusals, audit/history, kill switch prominent |
| Research/demo operator | Prove the whole chain works | Correlation IDs, visible acks, session history, health and robot truth |

## Core Use Cases

### 1. First-time visitor chats with Echo
1. User opens `/` on mobile.
2. Intake asks for name and comfort around physical AI dogs.
3. App creates a session and stores the session id in browser localStorage.
4. User sends a message.
5. Echo replies in dog persona and plays a virtual emote.
6. If the user asks project facts, Echo retrieves from the KB before answering.

**Success:** user gets a short, friendly answer; virtual dog animation matches the reply.

### 2. User requests a physical companion
1. User taps **Request physical companion**.
2. Chat shows `Pending admin approval`.
3. Admin sees the request with name, comfort answer, and session context.
4. Admin approves for a robot.
5. That session becomes the robot-connected session; other sessions remain virtual.
6. Physical emotes/motion tools are offered only to the approved session.

**Success:** exactly one holder can drive a physical robot; everyone else sees virtual-only
emotes.

### 3. Admin reassigns or aborts a robot session
1. Admin opens Robot or Sessions tab.
2. Admin aborts current holder or gives the robot to another session.
3. Old holder is marked aborted and returns to virtual mode.
4. Service sends best-effort dock/undock assignment commands and records acks/refusals.

**Success:** lock state is obvious to staff and both users see the correct state.

### 4. Staff manages safety
1. Admin checks robot presence, battery, dock state, and gates.
2. Admin fires **Kill switch**.
3. Backend writes only safe shadow values: `motion_enabled=false`, `dry_run=true`.
4. UI shows updated gates or recent status once reported.

**Success:** no admin UI path can enable motion accidentally.

### 5. Staff updates Echo's knowledge or behavior
1. Admin uploads a document in Knowledge.
2. Admin starts KB ingestion and sees sync status.
3. Admin edits or clears system prompt directives.
4. Next user turn reflects the updated prompt or KB content.

**Success:** content and behavior changes are possible without a redeploy.

### 6. Demo operator validates autonomy and observability
1. Admin injects a synthetic event such as low battery.
2. EventEngine triggers an unprompted, motion-free agent turn.
3. Admin can inspect session history and recent robot command outcomes.

**Success:** autonomous reactions are visible and do not grant motion.

## Mobile Screen Scope

### Screen A - Intake
**Purpose:** create a named session with minimal friction.

Content:
- Product name: `Echo the Robot Dog`.
- Name input.
- Comfort checkbox: `I am comfortable around Physical AI Dogs`.
- Primary button: `Start chatting`.

States:
- Empty name: allow fallback name like `friend` or show inline validation.
- Network failure: inline error and retry.
- Returning user: skip intake if `guidemate_session_id` exists.

### Screen B - Chat Home
**Purpose:** main user experience.

Layout:
- Top app bar: Echo name, connection badge, Start new session icon/text.
- Dog avatar area: large virtual dog state, current emote label, optional animation.
- Status chip row: `Virtual`, `Pending`, `Physical: turtlebot468`, `Motion locked`,
  `Docked`, `Battery ?/percent`.
- Message list with user and Echo bubbles.
- Composer: text input, send button, future mic button.
- Companion action: `Request physical companion` when virtual and no pending request.

Required states:
- Virtual mode: avatar-only emotes.
- Pending approval.
- Approved physical companion.
- Denied.
- Aborted/disconnected.
- Robot unreachable.
- Agent/service error.
- Dog muted by admin.

Mobile behavior:
- Composer stays reachable at bottom.
- Message list scrolls without pushing controls off-screen.
- Status chips wrap to a second row rather than clipping.
- Touch targets at least 44 px high.

### Screen C - Physical Request Status
Can be a banner inside Chat Home rather than a separate route.

States:
- `Pending admin approval`.
- `Approved: connected to <robot_id>`.
- `Denied by admin`.
- `Session disconnected by admin - back to virtual`.

Actions:
- Request physical companion.
- Dismiss denied/aborted banner only after state has been seen.

### Screen D - Voice Mode
**Phase 5 scope.**

Content:
- Mic button with recording/listening/processing states.
- Transcript preview before or after send.
- Audio playback affordance for Echo's Polly voice.
- Emote sync indicator: reply waits for physical `running` ack when applicable, with
  timeout fallback.

Failure states:
- Browser mic permission denied.
- STT unavailable.
- TTS unavailable.
- Emote ack timeout.

## Admin Screen Scope

Admin is mobile-compatible but optimized for laptop/tablet operation.

### Admin Login
- Password form.
- Wrong password, rate limited, and admin-not-configured states.
- Uses HttpOnly signed cookie; no token visible to JS.

### Flags Tab
Controls:
- `dog_muted`
- `emotes_enabled`
- `motion_tools_enabled`
- `persona_enabled`
- `kb_enabled`

Behavior:
- Toggles save immediately.
- Failed save reverts the control.
- Add short inline explanation per flag before polish is complete.

### Prompt Tab
Controls:
- System prompt textarea.
- Save.
- Reset to built-in persona.

Behavior:
- Blank means built-in Echo persona.
- Prompt applies on the next turn.

### Requests Tab
Content:
- Pending companion requests.
- Name, comfort answer, session id, created time.
- Approve and Deny.
- Robot selector when more than one robot exists.

Behavior:
- Approval may abort/reassign the existing holder.
- Show result of approval and any assignment command refusal.

### Sessions Tab
Content:
- All sessions: name, request state, robot binding, created time.
- Transcript viewer.
- Give robot/reassign action.

Behavior:
- Read-only transcript by default.
- Reassign requires explicit action.

### Robot Tab
Content:
- Robot cards: robot id, presence, battery, dock state, safety gates.
- Current holder.
- Kill switch.
- Abort robot session.
- Direct command buttons: `stop`, `dock`, allowed primitives.
- Assignment-event log with latest dock/undock acks/refusals.

Behavior:
- Refusals are first-class outcomes, not hidden errors.
- Kill switch is visually destructive and one-way-to-safe.
- Direct commands go through the same bridge safety layer as agent commands.

### Knowledge Tab
Content:
- Document upload.
- Document list: key, size, modified time.
- Delete.
- Sync/ingest button and status.

Behavior:
- Safe filename normalization.
- Ingestion status visible after upload.

### Health/Maps Tabs
Planned/pinned by implementation scope.

Health:
- `/healthz`, `/readyz`, robot heartbeat, recent errors, recent commands, cost/latency
  metrics if available.

Maps:
- Last uploaded map image from S3.
- Timestamp/source metadata.
- Empty state when no map exists.

## Information Architecture
```
/                         User chat
  Intake                  first visit only
  Chat                    virtual or physical companion session
  Voice controls          same chat route, progressive enhancement

/admin                    Staff console
  Login
  Flags
  Prompt
  Requests
  Sessions
  Robot
  Knowledge
  Health                  planned
  Maps                    planned
```

## Design System Direction

### Visual Tone
- User chat: approachable, bright, companion-like.
- Admin: restrained, dense, operational.
- Avoid making the admin look playful; safety state must read clearly.

### Components
- Status chips for robot/session state.
- Message bubbles for chat.
- Avatar/emote surface for virtual dog.
- Banner for request lifecycle.
- Robot status cards for repeated robot entries.
- Tables for KB docs and sessions on desktop; stacked list rows on mobile.
- Destructive buttons only for kill switch, deny/delete, abort.

### Copy Rules
- Echo replies short and dog-like.
- UI copy should distinguish `virtual` from `physical`.
- Robot refusal copy should say why: docked, motion disabled, dry-run, unreachable.
- Do not imply physical movement when an emote is avatar-only.

## Needed Artifacts

### Product/UX
- Mobile wireframes for Intake, Chat Home, Request states, Voice Mode.
- Admin wireframes for Login, Requests, Sessions, Robot, Knowledge, Health, Maps.
- User-flow diagram: visitor chat -> request companion -> admin approval -> physical session
  -> abort/reassign.
- State machine diagram for session/request/robot lock.
- Empty/error/loading state inventory.

### Visual Design
- Echo avatar set: idle, happy, yes/nod, no/head-shake, sleeping/muted,
  physical-connected, offline.
- Motion/emote microinteraction specs: duration, loop count, reduced-motion fallback.
- Icon set mapping: send, mic, stop, dock, kill switch, upload, sync, transcript.
- Color tokens: neutral admin palette, success/warning/danger/info states.
- Typography and spacing tokens for mobile and desktop.

### Content
- Intake copy.
- Companion request and approval/denial messages.
- Robot safety/refusal messages.
- Admin helper text for flags and kill switch.
- KB seed docs and demo questions.
- Echo built-in persona prompt and admin prompt examples.

### Engineering/Integration
- API contract for session state, chat response, admin requests, robot status, KB status.
- Frontend state matrix for virtual/pending/approved/denied/aborted.
- Accessibility checklist: keyboard flow, labels, contrast, focus, reduced motion.
- Playwright scenarios for two-user companion flow and admin actions.
- Observability fields surfaced in UI: `turn_id`, `cmd_id`, `session_id`, `robot_id`.

### Demo/Research
- Demo script for no-motion docked validation.
- Demo script for physical companion approval with dry-run acks.
- Screenshots/video captures for report/presentation.
- Risk register for what is simulated vs physically verified.

## Current Implementation Fit

Already present in the repo:
- FastAPI app serving `/` and `/admin`.
- Session intake, localStorage session id, and chat API.
- DogAgent with persona, emote, motion, status, and KB tool gating.
- Companion request flow and robot lock model.
- Admin login, flags, prompt, requests, sessions, robot controls, KB management.
- DynamoDB-backed sessions/messages/requests/config.
- MQTT robot registry and shared command/ack schema.
- Assignment dock/undock command attempts with recorded acks/refusals.
- Tests for core agent, sessions, admin, autonomy, observability, and bridge surfaces.

Design gaps to close:
- Current chat UI is functional HTML, not the final mobile app experience.
- No polished responsive layout, avatar asset set, or visual system yet.
- Voice controls are in implementation scope but not represented in the current user UI.
- Admin has no Health or Maps tab in the current HTML even though they are scoped.
- Robot selector in admin request approval is still hardcoded to `turtlebot468`.
- User-facing status copy needs a full state matrix and accessibility pass.

## Acceptance Criteria

### User Chat
- On a 390 px wide mobile viewport, intake, chat history, companion status, and composer
  are usable without horizontal scrolling.
- Every Echo reply shows an emote state, or an explicit reason no emote played.
- User can tell whether they are virtual-only or physically connected.
- Request state updates without a page reload.
- Starting a new session clears only local browser state; old admin transcript remains.

### Admin
- Admin can complete a request approval, denial, abort, and reassign flow from one console.
- Admin can see who holds the robot lock.
- Kill switch cannot enable motion or disable dry-run from any UI/API path.
- Direct command results show `done`, `simulated`, `failed`, and refusal reasons.
- KB upload/sync/delete paths have visible success and failure states.

### Safety/Trust
- Physical robot controls are visible only as controlled/admin-approved actions.
- Refused commands are shown as expected safety outcomes when locked/docked.
- Robot state clearly distinguishes unknown, offline, locked, docked, and dry-run.
- No UI copy suggests that unapproved users can move the real robot.

## Out of Scope For This Design Pass
- Full campus navigation or semantic room lookup.
- Multi-org branding/user accounts.
- Physical motion validation on robot 468.
- Fleet orchestration beyond the existing multi-robot-ready architecture.
- Native mobile app; this scope assumes responsive web.
