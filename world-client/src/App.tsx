import { Canvas } from '@react-three/fiber'
import { MapControls } from '@react-three/drei'

import { useWorldRoom } from './net/useWorldRoom'
import { DemoAgents } from './scene/DemoAgents'

// floor-14.json's real footprint spans roughly x:[0,36] z:[0,21] (see Task 0.2's code-quality
// review) -- centered here rather than on the origin so the placeholder plane and camera
// target actually cover where the demo agent moves.
const FLOOR_CENTER: [number, number, number] = [18, 0, 10.5]

// Task 0.2 scaffold, extended just enough for an architecture-proof live demo: a grey plane
// stands in for the carpet that gets a real material/texture in Task 3.1, and <DemoAgents/>
// renders whatever the world-server is really simulating -- not hardcoded, not a mock. Full
// robot/visitor models are Task 3.2.
//
// useWorldRoom() is called here, OUTSIDE <Canvas>, deliberately: react-three-fiber's scene
// graph is a separate reconciler tied to its own render/animation loop, so a WebSocket
// connection made inside a Canvas child can be deferred until R3F actually renders a frame.
// The network layer belongs to the DOM-level React tree; only the visual result (agentIds/
// agents) is handed down as props to what's drawn inside the Canvas.
function App() {
  const { agentIds, agents } = useWorldRoom()

  return (
    <Canvas
      shadows
      camera={{ position: [FLOOR_CENTER[0] + 14, 22, FLOOR_CENTER[2] + 14], fov: 50 }}
      style={{ width: '100vw', height: '100vh', display: 'block' }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[FLOOR_CENTER[0] + 10, 20, FLOOR_CENTER[2] + 5]} intensity={1.2} castShadow />

      <mesh position={FLOOR_CENTER} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[50, 30]} />
        <meshStandardMaterial color="#8a8a8a" roughness={0.95} />
      </mesh>

      <DemoAgents agentIds={agentIds} agents={agents} />

      <MapControls target={FLOOR_CENTER} />
    </Canvas>
  )
}

export default App
