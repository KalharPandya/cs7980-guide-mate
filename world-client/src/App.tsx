import { Canvas } from '@react-three/fiber'
import { MapControls } from '@react-three/drei'

import { useWorldRoom } from './net/useWorldRoom'
import { useFloorPlan } from './net/useFloorPlan'
import { DemoAgents } from './scene/DemoAgents'
import { Floor } from './scene/Floor'
import { Walls } from './scene/Walls'
import { RoomLabels } from './scene/RoomLabels'
import { computeOutlineBounds } from './scene/floorPlanUtils'

// Task 0.2 scaffold, extended by Task 3.1 with the real floor/wall/label geometry (see
// scene/Floor.tsx, scene/Walls.tsx, scene/RoomLabels.tsx) and by the architecture-video slice
// with <DemoAgents/>, which renders whatever the world-server is really simulating -- not
// hardcoded, not a mock. Full robot/visitor models are Task 3.2.
//
// useWorldRoom() is called here, OUTSIDE <Canvas>, deliberately: react-three-fiber's scene
// graph is a separate reconciler tied to its own render/animation loop, so a WebSocket
// connection made inside a Canvas child can be deferred until R3F actually renders a frame.
// The network layer belongs to the DOM-level React tree; only the visual result (agentIds/
// agents) is handed down as props to what's drawn inside the Canvas. useFloorPlan() is called
// here for the same reason (it's a plain fetch(), not an R3F concern).
function App() {
  const { agentIds, agents } = useWorldRoom()
  const { floorPlan, error } = useFloorPlan()

  if (error) {
    return (
      <div style={{ padding: 16, color: '#b00020', fontFamily: 'sans-serif' }}>
        Failed to load floor plan: {error.message}
      </div>
    )
  }

  if (!floorPlan) {
    return <div style={{ padding: 16, fontFamily: 'sans-serif' }}>Loading floor plan...</div>
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
  const cameraPosition: [number, number, number] = [
    bounds.centerX + bounds.sizeX * 0.45,
    maxExtent * 0.85,
    bounds.centerZ + bounds.sizeZ * 0.7,
  ]

  return (
    <Canvas
      shadows
      camera={{ position: cameraPosition, fov: 50 }}
      style={{ width: '100vw', height: '100vh', display: 'block' }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[target[0] + 10, 20, target[2] + 5]} intensity={1.2} castShadow />

      <Floor floorPlan={floorPlan} />
      <Walls walls={floorPlan.walls} />
      <RoomLabels rooms={floorPlan.rooms} />

      <DemoAgents agentIds={agentIds} agents={agents} />

      <MapControls target={target} />
    </Canvas>
  )
}

export default App
