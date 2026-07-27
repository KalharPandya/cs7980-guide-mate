import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { AgentSnapshot } from "../net/useWorldRoom";

/**
 * Minimal architecture-proof agent renderer, NOT Task 3.2's real robot/visitor models. Draws
 * every synced agent as a plain colored box that lerps toward its live server position each
 * frame, purely to prove the Colyseus -> R3F pipeline moves something real in the browser.
 * Task 3.2 replaces this with SkeletonUtils-cloned GLB models; this file should be deleted or
 * folded into that task, not extended.
 *
 * Deliberately presentational (agentIds/agents passed in as props) rather than calling
 * useWorldRoom() itself -- the network connection is made once in App.tsx, outside <Canvas>,
 * so it isn't gated by react-three-fiber's own render loop. See App.tsx's comment.
 */
function AgentBox({ snapshot }: { snapshot: AgentSnapshot }) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((_state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const lerpFactor = Math.min(delta * 6, 1);
    mesh.position.x = THREE.MathUtils.lerp(mesh.position.x, snapshot.x, lerpFactor);
    mesh.position.z = THREE.MathUtils.lerp(mesh.position.z, snapshot.z, lerpFactor);
    mesh.rotation.y = snapshot.heading;
  });

  const color = snapshot.kind === "robot" ? "#1D9E75" : "#378ADD";

  return (
    <mesh ref={meshRef} position={[snapshot.x, 0.3, snapshot.z]} castShadow>
      <boxGeometry args={[0.5, 0.6, 0.5]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

export function DemoAgents({
  agentIds,
  agents,
}: {
  agentIds: string[];
  agents: Map<string, AgentSnapshot>;
}) {
  return (
    <>
      {agentIds.map((id) => {
        const snapshot = agents.get(id);
        if (!snapshot) return null;
        return <AgentBox key={id} snapshot={snapshot} />;
      })}
    </>
  );
}
