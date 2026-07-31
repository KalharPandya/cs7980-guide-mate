# Guide Mate: Virtual World Client

Three.js / React-Three-Fiber renderer for the virtual guide-fleet world. It's the
big-screen view of whatever `world/`'s Colyseus server is actually simulating: the floor
plan (floor, walls, room labels), every live agent (robots and simulated visitors) as
animated GLB models moving along their real navmesh routes, and a glowing route-line
overlay for whichever agent is currently navigating. Nothing here is a mock or a
placeholder: `AgentInstances` renders exactly the agents the server's `agents` map holds,
`RouteLines` renders the server's own live route polyline.

## Requirements
- Node.js >= 20
- `world/`'s server running and reachable (see below). Without it, the client shows a
  "Loading floor plan..." or "Failed to load floor plan" message and never draws any
  agents; there's no local fallback data.

## Install

```bash
cd world-client
npm install
```

## Run (dev)

```bash
npm run dev
```

Starts the Vite dev server, default `http://localhost:5173`. Open it in a browser once
`world/`'s server is up (`cd ../world && npm run dev`, default `ws://localhost:2567`) so
there's an actual room to join and agents to render.

Override the server URL with `VITE_WORLD_SERVER_URL` (a `.env`/`.env.local` in this
directory, or exported in the shell before `npm run dev`) if the world-server isn't on
the default `ws://localhost:2567`.

## Build

```bash
npm run build
```

Type-checks (`tsc`) then produces a static `dist/` via `vite build`. `npm run preview`
serves that build locally.

## Kiosk / big-screen mode

Append `?kiosk=1` to the URL (for example `http://localhost:5173/?kiosk=1`) to enable
Task 5.4's unattended-display mode, implemented in `src/KioskMode.ts`:
- Requests browser fullscreen on the first click/tap after load (the Fullscreen API only
  grants this from inside a real user-gesture handler, so it can't happen automatically
  on page load).
- After ~20 seconds of no pointer/wheel/touch input, hands the camera to a slow scripted
  auto-orbit (via `MapControls`' own built-in `autoRotate`); any new interaction cancels
  it immediately and gives manual control straight back.

With no `kiosk` param the page behaves exactly as a normal dev/rehearsal client: no
fullscreen request, no auto-orbit, plain `MapControls` drag/pan/zoom.

## Known limitation in this dev sandbox

In the sandboxed Claude Code environment this project was built in, the embedded Browser
pane could not composite/screenshot this scene (it stayed blank in captures even though
the app itself renders correctly to a real browser). If you're picking this project back
up in a similarly sandboxed session and screenshots come back blank, that's this
environment limitation resurfacing, not a regression in the app: verify by opening the
dev server in a real, non-sandboxed browser instead of trusting the pane's screenshot.
