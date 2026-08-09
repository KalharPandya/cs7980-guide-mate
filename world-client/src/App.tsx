import { useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { MapControls } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { MapControls as MapControlsImpl } from 'three-stdlib'

import { useWorldRoom, type ConnectionStatus } from './net/useWorldRoom'
import { useFloorPlan } from './net/useFloorPlan'
import { AgentInstances } from './scene/AgentInstances'
import { ChargingPads } from './scene/ChargingPads'
import { RouteLines } from './scene/RouteLine'
import { Floor } from './scene/Floor'
import { Walls } from './scene/Walls'
import { RoomLabels } from './scene/RoomLabels'
import { computeOutlineBounds, fitCameraToOutline } from './scene/floorPlanUtils'
import { useIsKiosk, useKioskFullscreen, useIdleAutoOrbit } from './KioskMode'

// Task 0.2 scaffold, extended by Task 3.1 with the real floor/wall/label geometry (see
// scene/Floor.tsx, scene/Walls.tsx, scene/RoomLabels.tsx), by Task 3.2 with
// <AgentInstances/>, which renders whatever the world-server is really simulating as real
// animated robot/visitor GLB models (scene/Robot.tsx, scene/Visitor.tsx) -- not hardcoded, not a
// mock, and no longer the placeholder colored boxes from the architecture-video slice (the
// old scene/DemoAgents.tsx, since removed) -- and by Task 3.3 with <RouteLines/> (the glowing
// carpet-projected route line, scene/RouteLine.tsx) plus a scene-wide bloom pass so it glows.
// Task 5.4 adds kiosk/big-screen mode (./KioskMode.ts): a `?kiosk=1` URL param that requests
// fullscreen on the first user gesture and drives an idle auto-orbit through MapControls'
// own autoRotate, without ever disabling MapControls itself.
//
// useWorldRoom() is called here, OUTSIDE <Canvas>, deliberately: react-three-fiber's scene
// graph is a separate reconciler tied to its own render/animation loop, so a WebSocket
// connection made inside a Canvas child can be deferred until R3F actually renders a frame.
// The network layer belongs to the DOM-level React tree; only the visual result (agentIds/
// agents) is handed down as props to what's drawn inside the Canvas. useFloorPlan() is called
// here for the same reason (it's a plain fetch(), not an R3F concern).

/**
 * Fixed (x, y, z) offset from the directional light's aim point (the floor's center, at y=0) to
 * the light's own position -- NOT scaled by the floor plan's size, so the lighting angle stays
 * the same regardless of floor-14.json's real extent. Used for both the light's `position` prop
 * below and, via LIGHT_OFFSET_DISTANCE, for sizing the shadow-camera's near/far planes from the
 * light's actual distance to what it's aimed at.
 */
const LIGHT_OFFSET: readonly [number, number, number] = [10, 20, 5]
const LIGHT_OFFSET_DISTANCE = Math.hypot(...LIGHT_OFFSET)

/** Vertical field of view, degrees -- passed to both the R3F <Canvas> camera prop and the
 * camera-framing fit below (fitDistanceAlongDirection needs the same fov the real camera will
 * render with, or the frame it computes won't match). */
const CAMERA_FOV_DEG = 50

/**
 * Fraction of the frustum's half-height/half-width held back as blank space on every side when
 * fitting the camera distance (see fitDistanceAlongDirection's doc comment in floorPlanUtils.ts).
 * Visual QA (2026-08-02) found the old fixed-offset camera left ~15% blank above and ~10% below
 * the building on a 1600x900 capture -- purely because that offset was never actually sized
 * against the fov/aspect. 0.06 leaves a small, deliberate breathing margin (so a wall segment
 * flush with the outline's bounding box doesn't render literally touching the viewport edge)
 * without giving back the old screenshot's wasted space.
 */
const CAMERA_FRAME_MARGIN = 0.06

/** Fallback aspect ratio (16:9) for the one render before the browser's real window size is
 * known -- App() runs on the server-less Vite SPA's first client render, where `window` already
 * exists, so this only matters as a defensive default (e.g. a future SSR/test harness). */
const DEFAULT_ASPECT = 16 / 9

/**
 * Extra room (in meters) added around the floor's own X/Z footprint when sizing the directional
 * light's orthographic shadow-camera frustum (Task 3.2 code-review Fix 1: the default ~10x10
 * frustum clips/vanishes shadows outside a small central patch of the real ~36x21m floor). The
 * light sits at LIGHT_OFFSET away from its aim point rather than straight overhead (~29 degrees
 * off vertical for the offset above), so the shadow camera's local left/right/top/bottom axes
 * don't line up 1:1 with world X/Z -- top/bottom in particular needs more headroom than sizeZ/2
 * alone would give. Verified against floor-14.json's real bounds (sizeX=36, sizeZ=21) by
 * projecting the floor's corners through the actual tilted view matrix: the exact required
 * half-extents came out to ~17.4m in X and +19.6m/-18.2m in top/bottom. Using the LARGER of
 * sizeX/sizeZ for BOTH axes plus this margin comfortably covers both, without having to compute
 * the exact tilted projection at runtime.
 */
const SHADOW_MARGIN_M = 6

/**
 * Rough ceiling on how far above the floor plane (y=0) anything that casts or receives a shadow
 * gets -- floor-14.json's tallest wall is 2.7m (Walls.tsx), and Robot.tsx/Visitor.tsx agents top
 * out under 1.7m. Only used to pad the shadow-camera's near/far planes (see shadowCornerDistance
 * below).
 */
const SHADOW_HEIGHT_PAD_M = 3

/**
 * Task 5.5: labels/colors for useWorldRoom()'s `status` (see net/useWorldRoom.ts's
 * ConnectionStatus doc comment for what each value means and why it exists at all -- the short
 * version: agent positions live in a mutable ref, not React state, so the scene keeps LOOKING
 * alive even after the connection has actually died, and this badge is the only thing that
 * tells a human glancing at the screen otherwise).
 */
const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  failed: 'Connection lost',
}
const CONNECTION_STATUS_COLOR: Record<ConnectionStatus, string> = {
  connecting: '#f5a623',
  connected: '#2ecc71',
  reconnecting: '#f5a623',
  failed: '#e74c3c',
}

/**
 * Small, unobtrusive connection-status badge, top-right, DOM-level (a sibling of <Canvas>, not
 * inside the 3D scene). Deliberately hidden in kiosk mode while status is 'connected' -- kiosk
 * mode's whole point (KioskMode.ts) is a clean, chrome-free presentation view for an unattended
 * big screen, so this must not show up as long as everything is healthy. It reappears the
 * instant kiosk's connection stops being healthy, because THAT is exactly the situation this
 * badge exists for: a frozen-but-alive-looking scene on a screen nobody is actively watching.
 * Outside kiosk mode (plain dev/rehearsal) it's always shown, healthy or not, since a developer
 * driving the app benefits from seeing connection state at a glance too.
 */
function ConnectionBadge({ status, isKiosk }: { status: ConnectionStatus; isKiosk: boolean }) {
  if (isKiosk && status === 'connected') return null
  return (
    <div
      style={{
        position: 'fixed',
        top: 10,
        right: 10,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: 'rgba(0, 0, 0, 0.55)',
        color: '#fff',
        fontFamily: 'sans-serif',
        fontSize: 12,
        lineHeight: 1,
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: CONNECTION_STATUS_COLOR[status],
          flexShrink: 0,
        }}
      />
      {CONNECTION_STATUS_LABEL[status]}
    </div>
  )
}

function App() {
  const { agentIds, agents, stations, status } = useWorldRoom()
  const { floorPlan, error } = useFloorPlan()
  // Stable target the directional light aims at (see the <primitive>/`target` prop below). A
  // THREE.DirectionalLight's `target` is itself an Object3D that three.js reads `matrixWorld`
  // from every frame to aim the shadow camera -- but it only gets a real (non-identity)
  // matrixWorld if it's actually part of the rendered scene graph, which is why this is rendered
  // as a <primitive> below rather than just assigned a position and left unmounted.
  const lightTarget = useMemo(() => new THREE.Object3D(), [])

  // Task 5.4: kiosk/big-screen mode, entirely opt-in via ?kiosk=1 (see ./KioskMode.ts for the
  // full reasoning on each hook). No-ops in every other way when the param is absent.
  const isKiosk = useIsKiosk()
  useKioskFullscreen(isKiosk)
  const mapControlsRef = useRef<MapControlsImpl>(null)
  const { onInteractionStart, onInteractionEnd } = useIdleAutoOrbit(isKiosk, mapControlsRef)

  if (error) {
    return (
      <>
        <ConnectionBadge status={status} isKiosk={isKiosk} />
        <div style={{ padding: 16, color: '#b00020', fontFamily: 'sans-serif' }}>
          Failed to load floor plan: {error.message}
        </div>
      </>
    )
  }

  if (!floorPlan) {
    return (
      <>
        <ConnectionBadge status={status} isKiosk={isKiosk} />
        <div style={{ padding: 16, fontFamily: 'sans-serif' }}>Loading floor plan...</div>
      </>
    )
  }

  // floor-14.json's real footprint is NOT centered on the origin (roughly x:[0,36] z:[0,21],
  // see Task 0.2's review and the Task 3.1 forward-note). Rather than recentering the rendered
  // geometry -- which would desync it from the raw floor-plan meters the world-server already
  // uses for agent positions (see world/src/rooms/WorldRoom.ts) -- the camera and MapControls
  // target are computed from the floor plan's actual bounding box every render, so this keeps
  // working even if floor-14.json's extent changes later.
  const bounds = computeOutlineBounds(floorPlan.walkableOutline)
  const target: [number, number, number] = [bounds.centerX, 0, bounds.centerZ]
  const maxExtent = Math.max(bounds.sizeX, bounds.sizeZ)

  // The VIEWING ANGLE (not the distance, and not the aim point) is still this same
  // [0.45, 0.85, 0.7] ratio the original camera placement used -- it's what gives this scene its
  // recognizable oblique, slightly-behind look, and visual QA confirmed that angle itself reads
  // fine, so it's kept as-is. What changed is the DISTANCE along it and WHERE it's aimed:
  // fitCameraToOutline (see its doc comment in floorPlanUtils.ts) found that aiming at the
  // outline's raw bounding-box center -- `target` above, still used for the light -- and just
  // solving for distance left the framing lopsided (verified against floor-14.json: the building
  // sat within 0.1% of the frame's bottom edge while ~16% sat empty at the top, because the
  // bounding-box center isn't the center of this non-convex "pinwheel" outline's own PROJECTED
  // extent). fitCameraToOutline solves for both together. It gets its own `cameraTarget`,
  // decoupled from the light/shadow-camera's `target` above: they're different concerns (where
  // the scene is lit vs. where the user's view/orbit is centered) and reusing `target` here would
  // have meant re-deriving and re-verifying the shadow-camera bounds math against a shifted aim
  // point for no real benefit.
  const cameraDirection = { x: bounds.sizeX * 0.45, y: maxExtent * 0.85, z: bounds.sizeZ * 0.7 }
  const maxWallHeight = floorPlan.walls.reduce((max, wall) => Math.max(max, wall.height), 0)
  const aspect =
    typeof window !== 'undefined' && window.innerHeight > 0
      ? window.innerWidth / window.innerHeight
      : DEFAULT_ASPECT
  const cameraFraming = fitCameraToOutline(
    floorPlan.walkableOutline,
    { x: bounds.centerX, z: bounds.centerZ },
    0,
    maxWallHeight,
    cameraDirection,
    CAMERA_FOV_DEG,
    aspect,
    CAMERA_FRAME_MARGIN,
  )
  const cameraTarget: [number, number, number] = [
    cameraFraming.target.x,
    cameraFraming.target.y,
    cameraFraming.target.z,
  ]
  const cameraPosition: [number, number, number] = [
    cameraFraming.position.x,
    cameraFraming.position.y,
    cameraFraming.position.z,
  ]

  const lightPosition: [number, number, number] = [
    target[0] + LIGHT_OFFSET[0],
    LIGHT_OFFSET[1],
    target[2] + LIGHT_OFFSET[2],
  ]

  // Half-width/height of the shadow camera's orthographic frustum -- see SHADOW_MARGIN_M's doc
  // comment for why the LARGER of sizeX/sizeZ is used for both axes rather than sizing each
  // axis independently off its own dimension.
  const shadowHalfExtent = maxExtent / 2 + SHADOW_MARGIN_M

  // near/far bound the shadow camera's depth range along its (tilted) view axis. Rather than
  // projecting the exact tilted frustum at runtime, this bounds near/far by the worst-case
  // straight-line distance from the light's aim point to any corner of the floor's footprint
  // (padded up to SHADOW_HEIGHT_PAD_M tall) -- a corner's distance measured along the view axis
  // can never exceed its full 3D distance from the aim point, so this is always a safe (if
  // slightly generous) bound.
  const shadowCornerDistance = Math.hypot(bounds.sizeX / 2, bounds.sizeZ / 2, SHADOW_HEIGHT_PAD_M)
  const shadowNear = Math.max(0.5, LIGHT_OFFSET_DISTANCE - shadowCornerDistance)
  const shadowFar = LIGHT_OFFSET_DISTANCE + shadowCornerDistance

  return (
    <>
      <ConnectionBadge status={status} isKiosk={isKiosk} />
      <Canvas
        shadows
        camera={{ position: cameraPosition, fov: CAMERA_FOV_DEG }}
        style={{ width: '100vw', height: '100vh', display: 'block' }}
      >
        {/* Without an explicit scene.background, three.js's renderTransmissionPass (triggered by
            Walls.tsx's GLASS_MATERIAL, meshPhysicalMaterial with transmission=1) has nothing to
            render behind a glass wall except the WebGLRenderer's default transparent/black clear
            -- so every glass wall sampled black through itself, rendering as a near-opaque dark
            panel. Most visible on the large diagonal Kitchen/1407/1408-vs-Event-Space glass front
            (floor-14.json's biggest glass run): a dark blue-black wedge over that whole room
            cluster in every screenshot taken during visual QA (2026-08-02), easy to mistake for a
            shadow-camera bug since it also darkened the floor/wall behind it. A plain white
            background (matching index.html's plain, unstyled <body> -- browsers default that to
            white, which is also this page's own empty-margin color) fixes it -- verified by an
            isolated before/after capture of just that glass front.
            Tried drei's <Environment> next, reasoning scene.environment (not background) is the
            "proper" PBR way to feed transmission/IBL: that was strictly worse. Its cubeCamera
            capture stalled the WebGL context badly enough under this environment's SwiftShader
            software rasterizer that the world-server websocket reconnected mid-capture, AND
            scene.environment is global -- three.js applies it as implicit IBL lighting to every
            PBR material in the scene, not just the transmissive ones, which visibly overexposed
            every solid wall too. A plain <color> background has neither failure mode: it only
            fills where nothing is drawn (unlike scene.environment, no implicit-IBL side effect on
            solid walls) and costs one clear color, not a per-frame/per-mount cubemap render. */}
        <color attach="background" args={['#ffffff']} />
        <ambientLight intensity={0.6} />
        <directionalLight
          position={lightPosition}
          target={lightTarget}
          intensity={1.2}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-shadowHalfExtent}
          shadow-camera-right={shadowHalfExtent}
          shadow-camera-top={shadowHalfExtent}
          shadow-camera-bottom={-shadowHalfExtent}
          shadow-camera-near={shadowNear}
          shadow-camera-far={shadowFar}
        />
        {/* Aims the directional light above (world space, at the floor's actual center) -- must be
            mounted in the scene graph, not just referenced, so its matrixWorld is real. */}
        <primitive object={lightTarget} position={target} />

        <Floor floorPlan={floorPlan} />
        <Walls walls={floorPlan.walls} />
        <RoomLabels rooms={floorPlan.rooms} />

        {/* Charging pads sit on the carpet under the robots that park on them -- rendered
            before the agents so a parked robot draws on top of its own pad. */}
        <ChargingPads stations={stations} />

        <AgentInstances agentIds={agentIds} agents={agents} />
        <RouteLines agentIds={agentIds} agents={agents} />

        <MapControls
          ref={mapControlsRef}
          target={cameraTarget}
          onStart={onInteractionStart}
          onEnd={onInteractionEnd}
        />

        {/* Task 3.3: scene-wide bloom so RouteLine.tsx's overdriven-color ribbon actually
            glows instead of just being a flat bright line -- see RouteLine.tsx's
            ROUTE_LINE_COLOR comment for why the color itself is pushed past 1.0. Low
            luminanceThreshold + mipmapBlur keeps only genuinely bright things (the route
            line) blooming, not the regular lit floor/walls/models. */}
        <EffectComposer>
          <Bloom luminanceThreshold={0.3} luminanceSmoothing={0.9} intensity={1.4} mipmapBlur />
        </EffectComposer>
      </Canvas>
    </>
  )
}

export default App
