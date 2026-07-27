import { Room } from "colyseus";
import type { Client } from "colyseus";

import { Agent, WorldState } from "./schema/WorldState.js";
import { buildNavMesh } from "../nav/buildNavMesh.js";
import type { BuiltNavMesh } from "../nav/buildNavMesh.js";
import { loadFloorPlan } from "../nav/loadFloorPlan.js";
import type { FloorPlan } from "../nav/loadFloorPlan.js";

/**
 * Minimal architecture-proof slice, not the real Task 1.2 (Crowd simulation for ~50 agents).
 * One demo robot walks the real navmesh to a random room's door and back, on a loop, purely
 * so a live client can be recorded showing real server-computed movement over a WebSocket --
 * this is NOT the multi-agent Detour Crowd loop Task 1.2 will build (no local avoidance, no
 * pool of many agents). Task 1.2's implementer should treat this as scaffolding to extend or
 * replace, not as the finished crowd-simulation loop.
 */
const DEMO_AGENT_ID = "demo-robot-1";
const DEMO_AGENT_SPEED_MPS = 1.4;
const DEMO_AGENT_PAUSE_MS = 1000;

interface DemoPath {
  points: { x: number; z: number }[];
  index: number;
}

export class WorldRoom extends Room<{ state: WorldState }> {
  private nav!: BuiltNavMesh;
  private plan!: FloorPlan;
  private demoPath: DemoPath | null = null;

  async onCreate(): Promise<void> {
    this.setState(new WorldState());
    console.log("WorldRoom created");

    this.plan = loadFloorPlan();
    this.state.floor = this.plan.floor;
    this.nav = await buildNavMesh(this.plan);

    const demoAgent = new Agent();
    demoAgent.id = DEMO_AGENT_ID;
    demoAgent.kind = "robot";
    demoAgent.state = "idle";
    demoAgent.x = this.plan.entrance.point[0];
    demoAgent.z = this.plan.entrance.point[1];
    this.state.agents.set(DEMO_AGENT_ID, demoAgent);

    this.pickNextDemoTarget();
    this.setSimulationInterval((deltaMs) => this.update(deltaMs));
  }

  /** Picks a random room, computes a real navmesh path to its door, and starts walking it. */
  private pickNextDemoTarget(attemptsLeft = this.plan.rooms.length): void {
    const agent = this.state.agents.get(DEMO_AGENT_ID);
    if (!agent) return;

    const room = this.plan.rooms[Math.floor(Math.random() * this.plan.rooms.length)];
    const { success, path } = this.nav.navMeshQuery.computePath(
      { x: agent.x, y: 0, z: agent.z },
      { x: room.door[0], y: 0, z: room.door[1] },
    );

    if (!success || path.length === 0) {
      console.warn(`WorldRoom: demo agent path to "${room.name}" failed, retrying`);
      if (attemptsLeft > 1) this.pickNextDemoTarget(attemptsLeft - 1);
      return;
    }

    this.demoPath = { points: path.map((p) => ({ x: p.x, z: p.z })), index: 0 };
    agent.state = `walking to ${room.name}`;
    console.log(`WorldRoom: demo agent heading to "${room.name}" (${path.length} waypoints)`);
  }

  private update(deltaMs: number): void {
    const agent = this.state.agents.get(DEMO_AGENT_ID);
    if (!agent || !this.demoPath) return;

    // Colyseus's setSimulationInterval callback receives deltaTime in MILLISECONDS; recast's
    // own step math is meters/second, so this must convert -- and clamp so a stall (e.g. a
    // slow tick after GC) doesn't teleport the agent through a wall in one step.
    const dt = Math.min(deltaMs / 1000, 0.1);
    const step = DEMO_AGENT_SPEED_MPS * dt;

    const target = this.demoPath.points[this.demoPath.index];
    const dx = target.x - agent.x;
    const dz = target.z - agent.z;
    const dist = Math.hypot(dx, dz);

    if (dist <= step) {
      agent.x = target.x;
      agent.z = target.z;
      this.demoPath.index += 1;

      if (this.demoPath.index >= this.demoPath.points.length) {
        agent.state = "idle";
        this.demoPath = null;
        setTimeout(() => this.pickNextDemoTarget(), DEMO_AGENT_PAUSE_MS);
      }
      return;
    }

    agent.heading = Math.atan2(dx, dz);
    agent.x += (dx / dist) * step;
    agent.z += (dz / dist) * step;
  }

  onJoin(client: Client): void {
    console.log(`WorldRoom: client joined (sessionId=${client.sessionId})`);
  }

  onLeave(client: Client): void {
    console.log(`WorldRoom: client left (sessionId=${client.sessionId})`);
  }
}
