import { Html } from '@react-three/drei'

import type { FloorPlanRoom } from './floorPlanTypes'

const LABEL_HEIGHT = 1.6 // meters above the floor

/**
 * Renders each room's name as a floating label above its `center` point.
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
 * `occlude` (Task 3.2 forward-note): without it, the label's DOM node has no depth test against
 * the WebGL scene, so it bleeds through walls at some camera angles. The plain boolean form
 * occludes against every other object drei tracks (root scene), which is enough here -- there's
 * no separate wall/label depth-testing pass to wire up for this simple demo.
 */
export function RoomLabels({ rooms }: { rooms: FloorPlanRoom[] }) {
  return (
    <>
      {rooms.map((room) => (
        <Html
          key={room.name}
          position={[room.center[0], LABEL_HEIGHT, room.center[1]]}
          center
          distanceFactor={10}
          occlude
        >
          <div
            data-room-label={room.name}
            style={{
              padding: '2px 6px',
              background: 'rgba(255,255,255,0.85)',
              color: '#202020',
              fontSize: 12,
              fontFamily: 'sans-serif',
              whiteSpace: 'nowrap',
              borderRadius: 3,
              pointerEvents: 'none',
            }}
          >
            {room.name}
          </div>
        </Html>
      ))}
    </>
  )
}
