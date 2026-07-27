import { Canvas } from '@react-three/fiber'
import { MapControls } from '@react-three/drei'

// Task 0.2 scaffold: bare R3F render check. A grey plane stands in for the
// carpet that gets a real material/texture in Phase 3. No models, no
// Colyseus connection yet -- this is just "does R3F render in a browser."
function App() {
  return (
    <Canvas
      shadows
      camera={{ position: [12, 12, 12], fov: 50 }}
      style={{ width: '100vw', height: '100vh', display: 'block' }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 15, 5]} intensity={1.2} castShadow />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[50, 50]} />
        <meshStandardMaterial color="#8a8a8a" roughness={0.95} />
      </mesh>

      <MapControls />
    </Canvas>
  )
}

export default App
