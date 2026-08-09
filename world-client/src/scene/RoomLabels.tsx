import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { Group, Vector3 } from 'three'

import type { FloorPlanRoom } from './floorPlanTypes'
import {
  ESTIMATED_LABEL_HEIGHT_PX,
  estimateLabelWidthPx,
  selectVisibleLabels,
  type LabelCandidate,
} from './roomLabelLayout'

const LABEL_HEIGHT = 1.6 // meters above the floor

/**
 * How often the screen-space layout pass runs, in seconds. The labels are DOM nodes that drei
 * repositions every frame regardless; this interval only governs how often we re-decide WHICH
 * ones may draw. 10 Hz is fast enough that a label's appearance keeps up with a dragged camera
 * (the anchor itself tracks at 60 Hz, only the show/hide decision lags by up to 100 ms) and slow
 * enough that the 18-room O(n^2) pass costs nothing next to the ~10 agents animating at 60 fps.
 */
const LAYOUT_INTERVAL_S = 0.1

/** Opacity fade, in ms. Long enough to read as a fade, short enough to not feel laggy. */
const FADE_MS = 120

/** Scratch vector, module scope so the per-tick loop allocates nothing. */
const scratch = /* @__PURE__ */ new Vector3()

interface LabelRuntime {
  /** The label pill itself (the `data-room-label` node), whose opacity we drive. */
  node: HTMLDivElement | null
  /** True when drei's `occlude` raycast says a wall is in front of this label. */
  occluded: boolean
  /** Cached CSS-pixel size. Constant, because the labels do not scale with camera distance. */
  width: number
  height: number
  /** False until `width`/`height` came from a real offsetWidth rather than the estimate. */
  measured: boolean
}

/**
 * Renders each room's name as a map annotation pinned above its `center` point.
 *
 * Uses drei's <Html> rather than <Text>: <Text> (troika-three-text) fetches its default font
 * from a CDN at runtime, which this sandboxed preview environment cannot reach -- a failed font
 * fetch there would either render no glyphs or spam the console with a network error, and the
 * verification bar for this task is zero console errors. <Html> renders a real DOM node using
 * the system font stack, so there's no external asset that can fail to load.
 *
 * Coordinate convention matches Floor.tsx/Walls.tsx/AgentInstances.tsx: labels are positioned in
 * raw floor-plan (x, z) meters, no recentering; App.tsx's single <group scale={[1, 1, -1]}>
 * reflects floor-plan z (north) to world -z so the top-down view reads north-up like the exit
 * map, with every in-scene component reflecting together.
 *
 * ## Constant screen size (2026-08-09)
 *
 * `distanceFactor` is deliberately NOT set. drei's distanceFactor multiplies the label by
 * `1 / (2 tan(fov/2) * dist)`, i.e. it pins the label to a size in WORLD meters, so it degenerates
 * at both ends of this scene's zoom range: framed on the whole floor the labels were unreadable
 * specks, and zoomed into one room they were oversized banners covering the floor. Without it
 * drei leaves the wrapper's scale at 1 and the pill keeps its natural CSS size at every camera
 * distance, which is how map annotation is supposed to behave: the text stays exactly as legible
 * whether you are looking at the building or at one classroom.
 *
 * The obvious cost of constant size is that zooming out no longer shrinks labels out of each
 * other's way, so they must be culled instead. That is what the layout pass below is for, and it
 * is the better trade: a hidden label is recoverable by zooming in, an illegible one is not.
 *
 * ## Collision culling
 *
 * Every LAYOUT_INTERVAL_S we project each room's anchor to CSS pixels with the SAME formula drei
 * uses to place the wrapper, hand the rectangles to the pure `selectVisibleLabels` (see
 * roomLabelLayout.ts for the priority/greedy rule and why labels are dropped rather than nudged),
 * and write the answer straight to each pill's `opacity`. Priority is the room's index in the
 * floor plan, which is fixed authoring order: any camera-derived priority (nearest first, largest
 * on screen first) would make two labels trade places as the camera drifts and flicker.
 *
 * Writing `opacity` via a ref rather than driving React state is deliberate: at 10 Hz a state
 * update would re-render all 18 <Html> components, and each drei <Html> re-renders its own
 * portal root on every render. A direct style write does the same job with zero reconciliation.
 *
 * Projection goes through `groupRef.current.localToWorld(...)` rather than hardcoding the
 * `z -> -z` mirror. The mirror lives in App.tsx and this component must not carry a second,
 * silently-drifting copy of it; asking the group for its own world matrix stays correct if the
 * parent transform ever changes.
 *
 * ## occlude
 *
 * `occlude` is kept, so a label does not shine through a wall. Passing `onOcclude` takes over
 * drei's own hiding (drei only sets `el.style.display` when no callback is given), which is
 * exactly what we want: occlusion and collision then resolve through ONE opacity write instead
 * of two components fighting over the same node's visibility. It also lets an occluded label be
 * marked ineligible so it does not reserve screen space against a label that CAN be seen.
 */
export function RoomLabels({ rooms }: { rooms: FloorPlanRoom[] }) {
  const groupRef = useRef<Group>(null)
  const { camera, size } = useThree()

  // Keyed by room name. Rebuilt only when the floor plan itself changes, so the ref callbacks
  // and onOcclude handlers below keep a stable identity across renders (a fresh ref callback
  // every render would make React detach and reattach every label node every render).
  const runtime = useMemo(() => {
    const map = new Map<string, LabelRuntime>()
    for (const room of rooms) {
      map.set(room.name, {
        node: null,
        occluded: false,
        width: estimateLabelWidthPx(room.name),
        height: ESTIMATED_LABEL_HEIGHT_PX,
        measured: false,
      })
    }
    return map
  }, [rooms])

  const handlers = useMemo(
    () =>
      rooms.map((room, index) => ({
        room,
        priority: index,
        setNode: (node: HTMLDivElement | null) => {
          const entry = runtime.get(room.name)
          if (entry) entry.node = node
        },
        setOccluded: (hidden: boolean) => {
          const entry = runtime.get(room.name)
          if (entry) entry.occluded = hidden
        },
      })),
    [rooms, runtime],
  )

  // Starts at the full interval so the very first frame runs a layout pass instead of leaving
  // the labels in their unresolved default state for 100 ms.
  const sinceLayout = useRef(LAYOUT_INTERVAL_S)
  const candidates = useRef<LabelCandidate[]>([])

  useFrame((_, delta) => {
    sinceLayout.current += delta
    if (sinceLayout.current < LAYOUT_INTERVAL_S) return
    sinceLayout.current = 0

    const group = groupRef.current
    if (!group) return
    camera.updateMatrixWorld()
    group.updateWorldMatrix(true, false)

    const bids = candidates.current
    bids.length = 0

    for (const { room, priority } of handlers) {
      const entry = runtime.get(room.name)
      if (!entry) continue

      // Measure once. The pill's size cannot change afterwards (constant screen size, no
      // webfont that could load late and reflow it), and offsetWidth forces a layout flush, so
      // reading it every tick for every label would be pure waste.
      if (!entry.measured && entry.node && entry.node.offsetWidth > 0) {
        entry.width = entry.node.offsetWidth
        entry.height = entry.node.offsetHeight
        entry.measured = true
      }

      scratch.set(room.center[0], LABEL_HEIGHT, room.center[1])
      group.localToWorld(scratch)
      scratch.project(camera)

      // NDC z outside [-1, 1] means the anchor is behind the camera or outside the frustum's
      // depth range. A point behind a perspective camera projects with a negative w, which
      // mirrors x and y through the origin, so without this test an anchor behind the viewer
      // would claim a bogus on-screen rectangle and suppress a real label.
      const inDepthRange = scratch.z >= -1 && scratch.z <= 1

      bids.push({
        key: room.name,
        priority,
        // Same mapping drei's defaultCalculatePosition uses, so the rectangle we test is the
        // rectangle the browser draws.
        centerX: scratch.x * (size.width / 2) + size.width / 2,
        centerY: -(scratch.y * (size.height / 2)) + size.height / 2,
        width: entry.width,
        height: entry.height,
        eligible: inDepthRange && !entry.occluded,
      })
    }

    const visible = new Set(selectVisibleLabels(bids, size))
    for (const [name, entry] of runtime) {
      if (entry.node) entry.node.style.opacity = visible.has(name) ? '1' : '0'
    }
  })

  return (
    <group ref={groupRef}>
      {handlers.map(({ room, setNode, setOccluded }) => (
        <Html
          key={room.name}
          position={[room.center[0], LABEL_HEIGHT, room.center[1]]}
          center
          occlude
          onOcclude={setOccluded}
        >
          <div
            ref={setNode}
            data-room-label={room.name}
            style={{
              padding: '2px 6px',
              background: 'rgba(255,255,255,0.88)',
              border: '1px solid rgba(0,0,0,0.10)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
              color: '#1f2933',
              fontSize: 12,
              lineHeight: '15px',
              fontWeight: 600,
              fontFamily: 'sans-serif',
              whiteSpace: 'nowrap',
              borderRadius: 4,
              pointerEvents: 'none',
              userSelect: 'none',
              // Starts hidden so nothing can flash as an unculled pile before the first layout
              // pass runs (which is on the very next frame, see sinceLayout's initial value).
              opacity: 0,
              transition: `opacity ${FADE_MS}ms linear`,
            }}
          >
            {room.name}
          </div>
        </Html>
      ))}
    </group>
  )
}
