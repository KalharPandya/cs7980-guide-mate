import { useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { MapControls } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { MapControls as MapControlsImpl } from 'three-stdlib'

import { useWorldRoom, type ConnectionStatus } from './net/useWorldRoom'
import { useFloorPlan } from './net/useFloorPlan'
import { useFurniture } from './net/useFurniture'
import { AgentInstances } from './scene/AgentInstances'
import { Furniture } from './scene/Furniture'
import { ChargingPads } from './scene/ChargingPads'
import { RouteLines } from './scene/RouteLine'
import { Floor } from './scene/Floor'
import { Cores } from './scene/Cores'
import { Walls } from './scene/Walls'
import { RoomLabels } from './scene/RoomLabels'
import { computeOutlineBounds } from './scene/floorPlanUtils'
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
  // Fetched separately from the floor plan, and its error is deliberately NOT surfaced or allowed
  // to block rendering: furniture is decoration, so a missing furniture file must degrade to the
  // previous bare-but-correct scene rather than replace the whole view with an error page the way
  // a missing floor plan does. Called here (outside <Canvas>) for the same reason useFloorPlan is
  // -- a plain fetch belongs to the DOM-level React tree, not to R3F's separate reconciler.
  const { furniture } = useFurniture()
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
  //
  // NORTH-UP CONVENTION: floor-plan z is NORTH and matches the authoritative exit map, but a
  // top-down three.js camera in right-handed space puts +z toward the BOTTOM of the screen,
  // which renders the map mirrored north<->south versus the exit map. The fix is a single
  // <group scale={[1, 1, -1]}> below that reflects ALL in-scene floor-plan content (floor,
  // walls, labels, agents, route lines) together, so floor-plan z (north) lands at world -z
  // (top of a north-up view) and everything stays mutually consistent. Because the camera,
  // MapControls target, and lights live OUTSIDE that group (in world space), each of their z
  // coordinates is negated here so they aim at the now-reflected content. computeOutlineBounds
  // stays in raw floor-plan meters; only the resulting world-space z coordinates are negated.
  const bounds = computeOutlineBounds(floorPlan.walkableOutline)
  const target: [number, number, number] = [bounds.centerX, 0, -bounds.centerZ]
  const maxExtent = Math.max(bounds.sizeX, bounds.sizeZ)
  const cameraPosition: [number, number, number] = [
    bounds.centerX + bounds.sizeX * 0.45,
    maxExtent * 0.85,
    -(bounds.centerZ + bounds.sizeZ * 0.7),
  ]

  // Same fixed lighting offset as before, but the z component is subtracted (not added) because
  // the scene content is reflected across z: this keeps the light in the SAME relative position
  // to the geometry it lights, so the rendered picture is a clean north-up mirror rather than
  // re-lit from the opposite side. (target[2] is already the reflected -bounds.centerZ.)
  const lightPosition: [number, number, number] = [
    target[0] + LIGHT_OFFSET[0],
    LIGHT_OFFSET[1],
    target[2] - LIGHT_OFFSET[2],
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
        camera={{ position: cameraPosition, fov: 50 }}
        style={{ width: '100vw', height: '100vh', display: 'block' }}
      >
        {/* Plain white background so the glass walls' transmission pass has something to sample
            instead of the renderer's black clear (which made every glass panel read as a dark
            box). Mirror-independent, so it is safe alongside the north-up reflection group. */}
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

        {/* NORTH-UP reflection group: everything that lives in floor-plan coordinates is a
            child of this ONE group, so reflecting z (north) to world -z happens once and all of
            it -- floor, walls, labels, agents, route lines -- stays mutually consistent (agents
            keep standing on the right walls, route lines keep following the geometry). three.js
            flips front-face winding automatically for this negative-determinant world matrix, so
            normals, culling, and shadows for the floor and walls stay correct. The camera, lights,
            and MapControls target sit OUTSIDE this group and have their z negated (see above). */}
        <group scale={[1, 1, -1]}>
          <Floor floorPlan={floorPlan} />
          {/* The elevator/stair shafts, as solid mass standing in the openings Floor.tsx cuts out
              of the slab. MUST be inside this reflection group with the floor, or the blocks would
              land mirrored across the building from the holes they fill. See Cores.tsx. */}
          <Cores holes={floorPlan.holes} walls={floorPlan.walls} />
          <Walls walls={floorPlan.walls} walkableOutline={floorPlan.walkableOutline} />
          {/* `walls` is passed for the label HEIGHT only (see RoomLabels.tsx): the labels are
              pinned above the plan's own tallest geometry, derived from the same
              coreHeightForWalls() the cores above are extruded to, so they clear the building
              instead of being occluded by it. */}
          <RoomLabels rooms={floorPlan.rooms} walls={floorPlan.walls} />

          {/* Furniture extracted from the source drawing, so the rooms read as furnished spaces
              instead of empty grey volumes. Must sit inside this reflection group with the floor
              and walls or every item lands mirrored across the building. RENDER-ONLY: none of this
              reaches the navmesh (see Furniture.tsx) -- agents walk through it. */}
          <Furniture furniture={furniture} />

          {/* Charging pads sit on the carpet under the robots that park on them, inside the
              reflection group so they mirror with the floor/walls/agents. Rendered before the
              agents so a parked robot draws on top of its own pad. */}
          <ChargingPads stations={stations} />

          <AgentInstances agentIds={agentIds} agents={agents} />
          <RouteLines agentIds={agentIds} agents={agents} />
        </group>

        <MapControls
          ref={mapControlsRef}
          target={target}
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
