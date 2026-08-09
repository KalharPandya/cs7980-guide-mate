# Virtual World Guide Fleet — Design + Development Plan

Date: 2026-07-26
Status: proposed (awaiting review)
Branch guidance: build on a new branch `feat/kalhar-virtual-world`, not the elevenlabs branch.

## TL;DR
A browser-based 3D virtual world where the existing central agent (Moses) directs up to ~50
virtual guide-robots that walk visitors to named rooms across a Northeastern University
Vancouver floor. The virtual world is the scale + navigation story; the physical robot stays
emotes-only. It reuses the existing IoT command bus so a virtual robot is interchangeable with
the real one to Moses. Every prerequisite is verified in place (AWS role, EC2, IoT things,
command schema, local toolchain). The whole thing is buildable by an AI coding agent with no
human GUI or hand-made art step, the single exception being the one-time authoring of the
floor-plan coordinates (a data task, done from the campus floor plans we already have).

## Goal and scope

In scope:
- One floor first (14th, since the floor plan is the most detailed), extensible to 2nd and 15th.
- Big-screen authoritative 3D renderer (the spectacle everyone watches).
- Central agent Moses assigns robots and issues navigation commands over the existing IoT bus.
- ~50 guide-robots plus ~45 server-simulated visitors so the world reads busy at scale.
- Lightweight phone controller: a person talks to Moses on their phone and a robot guides their
  avatar; the phone does NOT render 3D in this version.
- Professional-workspace look: grey carpet, glass walls, stylized-consistent, with a glowing
  route line projected on the carpet as the signature effect.

Out of scope (this version):
- 3D rendering on phones (deferred by decision).
- Literal snow or terrain deformation (carpet does not deform; the route line replaces it).
- Photoreal rendering; bespoke custom-authored characters (we use CC0 rigged models).
- Real Nav2 or ROS in the virtual world (it is plain pathfinding, not ROS).

## Experience and display surfaces
- Big screen (projector): the live 3D floor, Moses at the hub, robots weaving visitors to rooms.
- Each phone: scan a QR, become a visitor, talk to Moses (voice or text), watch your own avatar
  on the big screen. Real people make it relatable; simulated visitors keep it busy.
- Physical robot in the room: emotes only, same Moses brain, the tangible bridge to the real robot.

## Architecture (locked)

```
Moses (Bedrock + FastAPI, existing)
  -> MQTT publish  goto(room)         [AWS IoT Core, same topics as the real robot]
  -> Node world-server (Colyseus, on the existing t3.large)
       holds world state, runs recast Crowd navigation for ~95 agents,
       drives ~45 simulated visitors, subscribes to IoT Core
  -> WebSocket position stream
  -> Three.js / React Three Fiber big-screen client (renders + interpolates only)
```

- The browser never touches IoT Core. The Node world-server is the MQTT bridge and the
  authoritative owner of world state and navigation.
- A single floor-plan JSON is the source of truth: the server derives the navmesh from it, the
  client derives the render geometry from it. Coordinates are identical (both right-handed, Y up),
  so walls line up with the navmesh with no transform.
- Same command interface as the physical robot: Moses publishes a bounded command; the on-robot
  bridge turns it into Nav2, the world-server turns it into a recast Crowd target. One command,
  two executors. This makes the virtual world a safe testbed for Moses commands.

## The stack (verified versions and licenses, 2026-07-26)

Server (Node >= 20, ESM):
| Package | Version | License | Role |
|---|---|---|---|
| colyseus | 0.17.10 | MIT | authoritative room server (WebSocket, no WebRTC/TURN) |
| @colyseus/schema | 4.0.30 | MIT | delta state sync |
| recast-navigation (+ core/generators/wasm) | 0.43.1 | MIT | navmesh + Detour Crowd, runs in Node |
| earcut | 3.2.3 | ISC | triangulate the floor polygon in code |
| aws-iot-device-sdk-v2 (or mqtt.js) | current | Apache-2.0 | MQTT bridge to IoT Core (IAM creds) |

Client (browser, big screen):
| Package | Version | License | Role |
|---|---|---|---|
| three | 0.185.1 | MIT | renderer |
| @react-three/fiber | 9.6.1 | MIT | R3F (requires React 19) |
| @react-three/drei | 10.7.7 | MIT | helpers (Environment, ContactShadows, Line, MapControls) |
| meshline | 3.3.1 | MIT | glowing route ribbon |
| @react-three/postprocessing | current | MIT | bloom for the route glow |
| @colyseus/sdk | 0.17.x | MIT | client state sync (pin to the server line) |

Assets (all CC0, code-downloadable, animations embedded, verified by parsing the GLB files):
| Role | Asset | Source | Notes |
|---|---|---|---|
| Guide-robots | RobotExpressive.glb | raw GitHub (three.js examples) | CC0 (Quaternius/Don McCurdy), 14 clips incl. Idle/Walking |
| Visitors | Quaternius Animated Human / Ultimate Modular Men | poly.pizza static CDN | CC0, clips Idle/Walk/Working, professional-stylized |
| Visitors (fallback) | Kenney Mini Characters | kenney.nl direct zip (no auth) | CC0, 32 clips incl. wheelchair/accessibility props |
| Furniture | Kenney Furniture Kit | kenney.nl direct zip (no auth) | CC0, desk/chairDesk/computerScreen/laptop/tableGlass etc. |
| Carpet texture | ambientCG or Poly Haven, or shader noise | HTTP API / curl | CC0; shader-noise path needs no download at all |

## Key technical decisions (from verified research)

Rendering 50 agents at 60fps:
- Skeletal animation cannot be instanced in three.js. For ~50 this is a non-issue: use individual
  SkinnedMesh clones via `SkeletonUtils.clone` plus `useAnimations`, share one clip set, give each
  a random mixer time offset. LOD via drei `<Detailed>`. Budget ~5-15k tris per humanoid.
- Robots are rigid: batch all ~50 into one drei `<Instances>` (one draw call), animate transforms.
- Only reach for instanced skinning (bone-texture / VAT) if the count ever grows to hundreds.

Look:
- Grey carpet: MeshStandardMaterial, roughness ~0.95, tiling normal/roughness (CC0 or shader noise),
  max anisotropy for grazing god's-eye angles.
- Glass walls: one shared MeshPhysicalMaterial transmission pass (transmission is one extra
  full-scene pass regardless of panel count) or a cheaper fresnel-fake for most panels. Do NOT use
  per-panel drei MeshTransmissionMaterial (one FBO per instance, tanks FPS with many panels).
- Lighting: ambientLight + directionalLight + drei `<Environment>` with `<Lightformer>` children
  (soft reflections with no HDRI file). ContactShadows for moving agents, SoftShadows on the
  directional light, AccumulativeShadows for static furniture only.
- Signature effect: a meshline glowing ribbon laid flat on the carpet per active robot route
  (animated map offset for a flow toward the destination), plus a light bloom pass.
- Camera: angled PerspectiveCamera plus drei MapControls for the audience view, with an
  orthographic "map mode" toggle.

Navigation:
- recast-navigation Crowd, not grid A*. Reasons: smooth continuous motion and agent-agent
  avoidance out of the box, exact representation of angled/glass walls, one call per agent to
  route to a named room, continuous re-planning.
- Build: `init()` at boot, then `earcut` the floor outline to triangles at y=0, emit vertical
  quads for each wall segment (glass is just an ordinary obstacle), concat, `generateSoloNavMesh`.
- Named room to target: `NavMeshQuery.findClosestPoint(roomDoor)` then `agent.requestMoveTarget`.
- Loop: `crowd.update(dt)` inside Colyseus `setSimulationInterval`. Gotcha: Colyseus deltaTime is
  milliseconds, Detour expects seconds; divide by 1000 and clamp to ~0.1. Sim at 60 Hz, patch at
  20 Hz. `maxAgents` 128, `maxAgentRadius` >= largest agent radius. RecastConfig mixes meter and
  voxel units (walkableRadius/Height are voxels): compute them from `cs`.

IoT and command schema:
- Widen the fleet: the existing `guidemate-sim-policy` allows client id `guidemate-*` (Connect
  already covered) and topics `guidemate/turtlebotsim/*`. Add a fleet-scoped statement (for example
  `guidemate/virtual/+/*` plus the fleet thing shadow). One "virtual fleet" thing + cert, robots
  addressed by id in the topic. Clone the existing `scripts/create_sim_identity.sh` pattern.
- Command schema: add a `navigate` type to `shared/guidemate_msgs` Command (additive,
  backward-compatible; emote/motion/stop still validate). New bounded names: `goto`
  (params `{room}` or `{x,z}`), plus `assign` and `stop`. Keep the closed-vocabulary + confidence
  threshold + safe fallback pattern (Bounded Autonomy paper), matching the existing dock-guard
  default-deny posture.

## Floor-plan JSON data model (single source of truth)
```json
{
  "units": "meters",
  "floor": 14,
  "walkableOutline": [[0,0],[20,0],[20,15],[0,15]],
  "holes": [[[8,6],[12,6],[12,9],[8,9]]],
  "walls": [
    { "a": [0,0], "b": [20,0], "height": 3, "glass": false },
    { "a": [8,6], "b": [12,6], "height": 3, "glass": true }
  ],
  "rooms": [
    { "name": "Classroom 1425", "aliases": ["1425"], "center": [10,7.5], "door": [8,6] },
    { "name": "Kitchen", "center": [3,13], "door": [3,11] },
    { "name": "Event Space", "center": [16,12], "door": [14,10] }
  ]
}
```
Server: earcut(outline, holes) plus wall quads -> generateSoloNavMesh. Client: ShapeGeometry floor
plus extruded walls (glass -> transmission material) plus room labels. Routing: room name/alias ->
door -> findClosestPoint.

## Phased development plan

Phase 0 — Scaffolding and floor data
- Create `world/` (Colyseus server, ESM) and `world-client/` (Vite + R3F) in the repo.
- Author the 14th-floor JSON from the campus floor plan (rooms, doors, walls, glass flags).
- Fetch CC0 assets via the verified recipes into the repo (a `world/scripts/fetch_assets.sh`).
- Done when: JSON validates, assets present, both skeletons run locally.

Phase 1 — Server world and navigation (headless)
- WorldState schema (robots and visitors as MapSchema of x/z/heading/state).
- recast init, navmesh from JSON, Crowd(maxAgents 128), named-room routing.
- Crowd loop in setSimulationInterval (ms->s, clamp), positions into schema.
- Done when: headless test moves N agents to named rooms; @colyseus/loadtest at 95 agents; measured
  `crowd.update` wall-time on the t3.large (the ~5-sample perf check before trusting it).

Phase 2 — IoT bridge and command schema
- Add `navigate` to Command (unit tests that emote/motion/stop still validate).
- Node bridge subscribes to the virtual fleet topics, maps commands to Crowd targets.
- Widen the IoT policy and mint the virtual-fleet identity (clone create_sim_identity.sh).
- Done when: a goto published over IoT Core (dev cert) moves a virtual robot in server state,
  verified with the existing gated round-trip test pattern.

Phase 3 — Three.js renderer (the look)
- Derive floor, walls (glass transmission), labels from the same JSON.
- Carpet material, lighting (Environment + Lightformer + ContactShadows + SoftShadows), camera.
- Load robots (RobotExpressive) and visitors (Quaternius) via useGLTF + SkeletonUtils.clone +
  useAnimations; robots batched; LOD. Walk when moving, Idle when stopped.
- Route line (meshline) per active route + bloom.
- Done when: the floor and agents render and move smoothly, verified in the browser preview with a
  screenshot.

Phase 4 — Moses control, simulated visitors, phone controller
- Server-side simulated visitors: spawn at entrance, request a room, get assigned a robot, follow,
  depart (~45 for scale).
- Moses tool: assign a robot to guide a user to a room, grounded to the bounded vocabulary.
- Lightweight phone controller (reuse the Moses chat frontend) with QR join; a real user request
  routes through Moses to a real robot.
- Done when: end-to-end, a phone request drives a robot that guides the user avatar on the big
  screen, with ~45 sim visitors running.

Phase 5 — Polish and demo hardening
- Deploy the world-server on the t3.large next to FastAPI (systemd), load-check.
- Kiosk big-screen mode, scripted camera moments, bloom/shadow tuning.
- Kill switch via the existing admin panel; physical robot mirrors one virtual robot's emotes.
- Rehearse; write a risk register (simulated vs physically verified).

## Risks and open items
- 50 animated humanoids on the actual big-screen GPU is the top perf risk; Phase 3 must profile it
  and fall back to LOD / fewer skinned visitors if needed.
- t3.large running FastAPI + Node world-server + Bedrock calls is untested together; Phase 1 and
  Phase 5 both load-check.
- Floor-plan coordinates are eyeballed from the plans; good enough for a demo, refine if a room
  reads wrong.
- IoT policy change is on a shared AWS account; make it additive and reversible (a new policy
  statement, robot policy untouched), same discipline as the existing sim identity.

## Sources
Verified this session via the four research passes and live AWS inspection. Key references:
recast-navigation-js (github.com/isaac-mason/recast-navigation-js), Colyseus docs
(docs.colyseus.io), three.js SkeletonUtils and MeshPhysicalMaterial docs, drei docs
(drei.docs.pmnd.rs), Kenney (kenney.nl, CC0), Quaternius via poly.pizza (CC0), three.js
RobotExpressive (CC0), Bounded Autonomy (arXiv 2604.04703) for the bounded-command pattern.
