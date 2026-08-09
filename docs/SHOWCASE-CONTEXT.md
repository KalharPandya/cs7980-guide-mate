# Showcase Context - Guide Mate

One-page ground truth for the upcoming showcase. Last updated 2026-08-08.

## The task
- Demo two things side by side: the **physical robot** (Moses, in the room) and the **virtual robot room** (big-screen 3D world with a fleet of guide-robots).
- One brain drives both. "Moses" (the Bedrock agent) issues the same bounded IoT commands to a real robot or a virtual one. Virtual robot == physical robot to Moses.

## The goal (two surfaces on the day)
1. **Big screen:** live 3D floor (Northeastern Vancouver, 14th floor). ~50 virtual guide-robots plus ~45 simulated visitors, escorting people to named rooms with a glowing route line. This is the scale + navigation spectacle.
2. **Physical robot in the room:** same Moses brain, emotes + voice only. Voice chat (talk to Moses, it replies aloud), body emotes (wiggle / nod / shake), optional tricks (circle / spin). The tangible bridge to the real robot.
3. Optional: a person scans a QR on their phone, talks to Moses, and watches their own avatar get escorted on the big screen.

## Where we are

### Virtual room (branch `feat/kalhar-virtual-world`, ~110 commits ahead of main)
- **Built and reviewed: all phases 0-5.** 50-robot fleet + ~45 visitors spawn for real; live-verified 95 agents, 71-77 moving at once.
- Server-authoritative navigation works: navmesh from the floor JSON, Detour Crowd routing (room -> door -> point), smooth motion with avoidance, world persists without a viewer.
- MQTT bridge works (navigate / assign / stop, acks, heartbeats, kill-switch, emote-mirror to robot 468 off by default).
- Renderer works: floor, glass walls, 18 room labels, animated robots + visitors, live route line + bloom, reconnect, kiosk mode (`?kiosk=1`).
- Server perf has real headroom (full-frame update avg 0.53ms, 0/7500 ticks over budget on a dev box).

### Physical robot (branch `feat/kalhar-elevenlabs-voice`, current)
- **Voice loop works end to end:** mic -> text -> LLM -> spoken reply. ElevenLabs (Moses voice) with automatic AWS Transcribe/Polly fallback. Live-validated 2026-07-08.
- **Chat works:** Sonnet 4.6 persona grounded on a Bedrock Knowledge Base with citations.
- **Emotes + tricks work** and were run on real robot 468 on 2026-07-08 (spins / wiggles observed).
- Motion is **fail-closed / triple-gated** by design: env flag AND shadow AND not-dry-run, hard caps 0.15 m/s. Robot 468 real motion is banned unless deliberately armed on the Pi with a human observer. Current branch tip leaves 468 **disarmed**.

## Tech stack

| Layer | Physical robot / Moses | Virtual room |
|---|---|---|
| Brain | FastAPI + Strands Agents, Bedrock `us.anthropic.claude-sonnet-4-6` (us-west-2), KB `A1NIQYZ0KQ` | same Moses, publishes navigate/assign/stop |
| Voice | ElevenLabs (Scribe v2 STT + `eleven_flash_v2_5` TTS) with AWS Polly/Transcribe fallback | n/a |
| Command bus | AWS IoT Core MQTT (SigV4), schema in `shared/guidemate_msgs` | same IoT topics |
| World server | rclpy bridge (systemd) on the Pi | Node 20 + Colyseus 0.17 + recast-navigation 0.43 + mqtt.js, on t3.large |
| Renderer | n/a | Three.js 0.185 + React-Three-Fiber 9 + drei + meshline + postprocessing (Bloom) |
| Data | Create 3 base, RPLIDAR, OAK-D depth (mapping side, separate) | `world/data/floor-14.json` single source of truth |
| Hosting | Docker Compose + Caddy on the Pi | Docker Compose + Caddy on t3.large (`/world/*`) |
| Assets | n/a | CC0 only: RobotExpressive robots, Quaternius visitors, Kenney furniture |

## Last work window (what the recent sessions actually did)
- **Virtual room, 2026-08-02 to 08-03 (latest):** hardening and honesty. Real reconnect/persistence proof, cross-language wire-schema conformance test, escort completion measured at ~90% with a standing regression harness, shared wall materials (124 -> 2), 50-humanoid render budget quantified, floor-14 map re-traced from a hi-res source scan (walls F1 87.7% -> 93.9%), fixed a one-robot-fleet bug and a wrong-map bug that had passed all reviews, wrote a risk register and an upstream-library-findings note.
- **Physical robot, 2026-07-08 (last touched):** ElevenLabs voice finalized and deployed to prod, chat tricks wired to the real robot, motion dispatch/ack bugs fixed, then robot deliberately left disarmed pending a supervised Pi session.

## What is left to finish (demo blockers, highest first)
1. **Nobody has watched the virtual world at real frame rate in a real browser recently.** The sandbox browser never composites, and two headline bugs slipped past all tests this way. Open it in a real browser and eyeball the full 50-robot scene. (Highest risk, cheapest check.)
2. **World-server is not deployed to the live t3.large.** It was proven locally only. The real co-tenancy load (FastAPI + Node + Bedrock on 2 vCPU) is unrun.
3. **The IoT path for the virtual fleet has never touched real AWS IoT Core.** The identity script is dry-run only (`--apply` withheld, needs your call - it mutates account IAM). All bridge tests use a fake broker.
4. **Client GPU / FPS is computed, not measured.** ~1,845 animated bones/frame across 45 visitors is the unpriced cost; mitigation levers ranked (drop Bloom, fewer visitors, LOD) but not applied.
5. **No end-to-end rehearsal** (phone QR -> chat -> assignment -> avatar walks -> route line -> arrival) as one continuous human-driven flow.
6. **Physical robot arming:** to show real emotes on 468, it must be deliberately armed on the Pi with a human observer. Voice + chat need no arming.

## Watch-outs that cost real time before
- Virtual-world branch is edited by multiple Claude sessions at once; use surgical section-scoped git only.
- Green tests here mean "no known contradiction," not "verified working" (a reachability test lied for weeks). Weight "did a human watch it" above test output.
- FastDDS discovery-server rot on the Pi hangs dock/undock after long uptime; a service restart clears it.
