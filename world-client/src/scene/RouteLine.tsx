import { useMemo, useRef } from 'react'
import { extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber'
import * as THREE from 'three'
import { MeshLineGeometry, MeshLineMaterial, type MeshLineMaterialParameters } from 'meshline'

import type { AgentSnapshot } from '../net/useWorldRoom'

// Registers <meshLineGeometry>/<meshLineMaterial> as usable JSX intrinsics -- meshline ships
// plain THREE.BufferGeometry/THREE.ShaderMaterial subclasses, not R3F components, so R3F's
// catalog has to be told about them once via extend() (the same mechanism drei's own <Line>
// uses internally). Module-level (not per-component) since it's process-wide registration.
extend({ MeshLineGeometry, MeshLineMaterial })

// R3F v9's JSX typing is generated from whatever's in the `ThreeElements` interface --
// augmenting it here is what makes `<meshLineGeometry>`/`<meshLineMaterial>` type-check
// instead of erroring as unknown intrinsic elements.
declare module '@react-three/fiber' {
  interface ThreeElements {
    meshLineGeometry: ThreeElement<typeof MeshLineGeometry>
    meshLineMaterial: ThreeElement<typeof MeshLineMaterial>
  }
}

/**
 * Per-robot route line: a plain, matte red line drawn flat on the carpet showing the robot's
 * REMAINING path to its goal. The server now publishes exactly that: `Agent.route` is
 * re-derived every tick from Detour's ACTUAL remaining corridor
 * (world/src/rooms/WorldRoom.ts's `publishRobotRoute`, via `crowd.corners()`), already
 * starting at the robot's live position, as flattened x,z pairs. So this component just
 * renders `route` directly -- no client-side reconstruction. (It used to project the robot
 * onto a stale one-shot polyline and draw a straight connector from the robot to it; that
 * connector cut across walls whenever the crowd's real corridor diverged from the snapshot.
 * The corners-based server route removed the need for any of that.)
 *
 * One <RouteLineInstance> per robot, rendered unconditionally (not conditionally mounted on
 * "has a route") because `route` is mutated in place on a ref, not React state (see
 * useWorldRoom.ts), so there is no render to hook a mount/unmount off of; instead each
 * instance polls its own snapshot every frame in useFrame and rebuilds its line points,
 * exactly like Visitor.tsx polls `snapshot.state` for its walk/idle clip switch.
 *
 * Height above the floor: Floor.tsx's carpet sits at y=-0.005, agents render with their feet
 * at y=0 (Robot.tsx/Visitor.tsx) -- ROUTE_LINE_Y lifts the line just clear of the carpet
 * without floating up into the agent models.
 */
const ROUTE_LINE_Y = 0.02

/**
 * Line width, in MeshLineMaterial's screen-space units. Paired with `sizeAttenuation={0}` on the
 * material below, which is the actual fix for "the route is only visible at extreme zoom".
 *
 * ## What was wrong
 *
 * The width used to be a WORLD size (`sizeAttenuation={1}`, 0.06m). A world-space width has to
 * survive this scene's entire zoom range on one number, and it cannot: the default kiosk camera
 * (App.tsx frames the whole ~36x21m floor from ~37m out at fov 50) shows about 35m of world
 * across the viewport height, so on a ~900px canvas a 0.06m line is ~1.5 CSS pixels before the
 * floor's tilt foreshortens it further. A 1.5px semi-transparent dark red line on a light grey
 * floor is what the user was looking at, and it is why zooming in "fixed" it: zooming multiplies
 * pixels-per-meter, so the same line becomes tens of pixels wide once the camera is inside one
 * room.
 *
 * ## Why screen-space rather than a bigger world width
 *
 * Simply raising the world width trades one end of the zoom range for the other. To reach a
 * comfortable ~7px at the default framing it would need to be ~0.30m, and that same 0.30m
 * becomes a ~40px ribbon once the camera drops to room level, i.e. a fat band wider than the
 * 0.5m robot drawing it. There is no world number that is both.
 *
 * `sizeAttenuation={0}` removes the trade entirely: meshline's vertex shader then divides the
 * ribbon's expansion by the projection so the line holds a constant width ON SCREEN at any
 * camera distance (verified in the installed meshline@3.3.1 source, not assumed -- the
 * `if (sizeAttenuation == 0.)` branch multiplies the offset by the clip-space w and divides by
 * `resolution * projectionMatrix`, which cancels the perspective divide that otherwise shrinks
 * it with distance). That is also exactly the behaviour the rest of this scene's annotation
 * layer already committed to: RoomLabels.tsx deliberately drops drei's `distanceFactor` for the
 * same reason, because a route line and a room name are both map annotation, not furniture.
 *
 * ## The number
 *
 * meshline's screen-space width is NOT pixels; it is scaled by the camera's projection, so the
 * on-screen width works out to roughly `lineWidth / (2 / tan(fov/2))` px, i.e. ~lineWidth/4.3 px
 * at App.tsx's fov of 50. 30 therefore lands around 7 px, which is a clear, obviously-deliberate
 * marker at the default framing without being a band. It is resolution-independent, so it does
 * not thin out on a big kiosk display.
 *
 * ## Bloom
 *
 * Unchanged, deliberately: App.tsx's <Bloom luminanceThreshold={0.3}> thresholds PER PIXEL
 * luminance, and ROUTE_LINE_COLOR's luminance (~0.20, see its comment) is untouched by this.
 * Widening the line only puts more pixels below the threshold, so the route stays matte and
 * still does not glow -- the width fix cannot smuggle the removed glow back in.
 */
const ROUTE_LINE_WIDTH_SCREEN = 30

/** Plain solid red, DELIBERATELY dim enough NOT to bloom. App.tsx runs a scene-wide <Bloom>
 * with luminanceThreshold=0.3; its luminance is the standard dot(color, [0.2125,0.7154,0.0721]),
 * which for this red is ~0.20 -- below 0.3 -- so the line stays matte and does NOT glow. Kept
 * <= 1.0 on every channel (and toneMapping left ON, i.e. no `toneMapped={false}`) so it can
 * never be pushed into bloom range the way the old overdriven cyan was. */
const ROUTE_LINE_COLOR = new THREE.Color(0.75, 0.05, 0.05)

/** Below 2 points there's no line to draw (a single point degenerates to nothing). A parked/
 * idle robot has an empty route (see WorldRoom.ts's arrival clear), so this also keeps an idle
 * robot from showing any line. */
const MIN_ROUTE_POINTS = 2

/**
 * Expands the server's flattened (x0, z0, x1, z1, ...) route into the flat
 * [x0, y, z0, x1, y, z1, ...] triples MeshLineGeometry.setPoints accepts (lifting every
 * vertex to ROUTE_LINE_Y), or null when there is nothing drawable (fewer than 2 points).
 *
 * No reconstruction: the server already publishes the robot's remaining corridor starting
 * at the robot's live position (WorldRoom.publishRobotRoute), so the polyline is drawn
 * exactly as received.
 */
function buildRoutePoints(route: ArrayLike<number>): number[] | null {
  const pointCount = Math.floor(route.length / 2)
  if (pointCount < MIN_ROUTE_POINTS) return null

  const points: number[] = []
  for (let i = 0; i < pointCount; i++) {
    points.push(route[i * 2], ROUTE_LINE_Y, route[i * 2 + 1])
  }
  return points
}

function RouteLineInstance({ snapshot }: { snapshot: AgentSnapshot }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const geometryRef = useRef<MeshLineGeometry>(null)
  const size = useThree((state) => state.size)
  // MeshLineMaterialParameters.resolution is a required constructor argument (unlike every
  // other prop here, which is fine as a plain reactive JSX prop) -- but this must be computed
  // ONCE (empty deps), not from `size` directly, or a resize would change `args`'s identity
  // and make R3F destroy/recreate the whole material every time the window resizes. The
  // reactive `resolution` prop below (which DOES track `size`) is what actually keeps it
  // correct after mount.
  const materialArgs = useMemo<[MeshLineMaterialParameters]>(
    () => [{ resolution: new THREE.Vector2(1, 1) }],
    [],
  )

  useFrame(() => {
    // Rebuild the line from the server's route every frame (cheap for a handful of robots).
    // The server re-derives `route` from Detour's live corridor each tick, so it already
    // starts at the robot and shrinks as the robot advances -- just render it.
    const points = buildRoutePoints(snapshot.route)
    const visible = points !== null
    if (points && geometryRef.current) {
      geometryRef.current.setPoints(points)
    }
    if (meshRef.current) {
      meshRef.current.visible = visible
    }
  })

  return (
    <mesh ref={meshRef} visible={false}>
      <meshLineGeometry ref={geometryRef} />
      <meshLineMaterial
        args={materialArgs}
        color={ROUTE_LINE_COLOR}
        lineWidth={ROUTE_LINE_WIDTH_SCREEN}
        sizeAttenuation={0}
        resolution={[size.width, size.height]}
        // REQUIRED, not cosmetic: without this the route line is not thin, it is INVISIBLE.
        //
        // App.tsx wraps every in-scene component in <group scale={[1, 1, -1]}> for the north-up
        // convention. That is a mirror, so the mesh's world matrix has a NEGATIVE determinant,
        // and three.js reacts by flipping the winding convention for the whole draw
        // (WebGLRenderer computes `frontFaceCW = object.matrixWorld.determinant() < 0` and calls
        // gl.frontFace(CW)). For ordinary geometry that is exactly right, because mirroring the
        // vertices really does reverse their projected winding.
        //
        // A meshline ribbon is not ordinary geometry. Its two triangles per segment are expanded
        // in SCREEN space by the vertex shader: each vertex is offset along +/- the perpendicular
        // of the PROJECTED segment direction (meshline@3.3.1's vertexShader, `normal = vec4(-dir.y,
        // dir.x, ...)` with the +1/-1 `side` attribute). Working the signed area out from that
        // source, the triangles come out counter-clockwise in NDC for ANY segment, mirrored parent
        // or not, because the offset is derived from the direction AFTER projection. So the mirror
        // flips the culling convention while the ribbon's winding does not follow, and every route
        // line is back-face culled.
        //
        // Measured, not deduced: with the line at its new screen-space width (~7px, unmissable)
        // and the default FrontSide material, a full-frame gl.readPixels of the live scene found
        // ZERO red pixels while the server was publishing 12-22m routes for all five robots.
        // Adding this one prop, changing nothing else, made them draw. A flat unlit ribbon has no
        // meaningful back face, so drawing both sides costs nothing and makes the line immune to
        // the parent transform.
        side={THREE.DoubleSide}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}

/**
 * Renders every ROBOT's remaining-route line. Visitors are explicitly skipped -- only robots
 * are dispatched a route to show, and a visitor must never draw a line.
 */
export function RouteLines({ agentIds, agents }: { agentIds: string[]; agents: Map<string, AgentSnapshot> }) {
  return (
    <>
      {agentIds.map((id) => {
        const snapshot = agents.get(id)
        if (!snapshot) return null
        if (snapshot.kind !== 'robot') return null
        return <RouteLineInstance key={id} snapshot={snapshot} />
      })}
    </>
  )
}
