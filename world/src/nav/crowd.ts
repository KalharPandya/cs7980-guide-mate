/**
 * Thin wrapper around recast-navigation's Detour Crowd for the world-server's agent
 * simulation loop (Task 1.2). Owns a fixed-capacity Crowd, maps caller-supplied string
 * agent ids to the underlying CrowdAgent handles, and exposes a fixed-timestep tick()
 * that steps the crowd and reports each tracked agent's resulting position + a heading
 * derived from its current velocity.
 *
 * Detour Crowd API notes (recast-navigation 0.43.1, verified against the installed
 * `node_modules/@recast-navigation/core/dist/crowd.d.ts` -- not guessed from memory,
 * since Task 1.1 already hit a real packaging drift with this library):
 *   - `new Crowd(navMesh, { maxAgents, maxAgentRadius })`.
 *   - `crowd.addAgent(position, params)` returns a `CrowdAgent` object directly (NOT a
 *     bare numeric handle) -- it carries `.agentIndex` plus the movement/query methods
 *     (`requestMoveTarget`, `position()`, `velocity()`, ...). This module still keeps
 *     its own string-id -> CrowdAgent map (that's the stable id the rest of the server
 *     works with); the library's own numeric index is never exposed past this file.
 *   - `crowd.update(dt)` steps a fixed timestep in SECONDS with no interpolation (the
 *     2/3-argument interpolated form documented on `Crowd.update` is not used here --
 *     WorldRoom does its own ms->seconds conversion and clamping before calling tick()).
 */
import { Crowd } from "recast-navigation";
import type { CrowdAgent, CrowdAgentParams, CrowdParams, NavMesh } from "recast-navigation";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Per-agent tuning; any field left unset falls back to recast-navigation's own default
 * (see `crowdAgentParamsDefaults` in `@recast-navigation/core`). */
export type AgentParams = Partial<CrowdAgentParams>;

export interface AgentSnapshot {
  id: string;
  x: number;
  z: number;
  heading: number;
  /** Current speed in m/s (`hypot` of the agent's xz velocity). Exposed alongside
   * heading so callers can derive their own "idle vs moving" semantics without this
   * module needing to know anything about how a caller represents agent state. */
  speed: number;
}

/** Below this speed (m/s), velocity direction is noise (recast still reports a tiny
 * nonzero velocity while an arrived agent settles) -- keep the last real heading instead
 * of snapping it to `atan2(0, 0) === 0` every tick the agent is stopped. */
const MIN_HEADING_SPEED_MPS = 0.01;

export class AgentCrowd {
  private readonly crowd: Crowd;
  private readonly byId = new Map<string, CrowdAgent>();
  private readonly lastHeading = new Map<string, number>();

  constructor(navMesh: NavMesh, params: CrowdParams) {
    this.crowd = new Crowd(navMesh, params);
  }

  /**
   * Adds a tracked agent at `position` (nav-space; pass `y: 0` -- the navmesh built by
   * buildNavMesh.ts is a flat single floor). Throws if `id` is already tracked: a silent
   * overwrite would orphan the previous CrowdAgent inside the underlying Crowd (it would
   * keep stepping and consuming a slot up to `maxAgents`, invisibly).
   *
   * Returns `false` (does NOT track the agent) if the underlying Crowd is already at its
   * `maxAgents` capacity. Verified empirically (recast-navigation 0.43.1, not guessed):
   * `Crowd.addAgent` does not throw and does not return null/undefined at capacity --
   * the native `dtCrowd::addAgent` returns agentIndex `-1`, and the JS wrapper still
   * builds and returns a `CrowdAgent` wrapping that invalid index (see
   * `node_modules/@recast-navigation/core/dist/index.mjs`'s `Crowd.addAgent`). That
   * "ghost" agent's `.position()` reads a garbage default (`{0,0,0}`), `.state()` reads
   * an invalid enum value, and `.requestMoveTarget()` always returns `false` -- but the
   * OTHER already-tracked agents are unaffected and the crowd's real agent count doesn't
   * change. So this checks `agent.agentIndex < 0` right after the call and refuses to
   * register the ghost rather than trusting it: the caller (WorldRoom.addAgent) is
   * expected to pre-check the live agent count against MAX_AGENTS before ever reaching
   * here, so this is a defense-in-depth backstop, not the primary gate.
   */
  addAgent(id: string, position: Vec3Like, params: AgentParams = {}): boolean {
    if (this.byId.has(id)) {
      throw new Error(`AgentCrowd.addAgent: agent id "${id}" already exists`);
    }
    const agent = this.crowd.addAgent(position, params);
    if (agent.agentIndex < 0) {
      return false;
    }
    this.byId.set(id, agent);
    this.lastHeading.set(id, 0);
    return true;
  }

  /** Removes a tracked agent from the crowd. No-op if `id` isn't tracked. */
  removeAgent(id: string): void {
    const agent = this.byId.get(id);
    if (!agent) return;
    this.crowd.removeAgent(agent);
    this.byId.delete(id);
    this.lastHeading.delete(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Count of agents this wrapper is currently tracking (`byId.size`) -- for soak/leak
   * tests (world/scripts/soaktest.ts) to verify this map returns to baseline after many
   * spawn/despawn cycles, not just that `addAgent`/`removeAgent` are individually called.
   * Since `lastHeading` is always written/deleted in lockstep with `byId` (see addAgent/
   * removeAgent above), this one number stands in for both maps' sizes. */
  get size(): number {
    return this.byId.size;
  }

  /**
   * Requests the named agent move toward `target` (nav-space; pass `y: 0`). Returns
   * `false` if `id` isn't tracked, or if the underlying `requestMoveTarget` call itself
   * reports failure (e.g. no polygon near enough to `target` on this navmesh).
   */
  requestMoveTarget(id: string, target: Vec3Like): boolean {
    const agent = this.byId.get(id);
    if (!agent) return false;
    return agent.requestMoveTarget(target);
  }

  /**
   * Steps the crowd by exactly `dtSeconds` (fixed timestep, no interpolation) and
   * returns every tracked agent's resulting position/heading/speed. Callers own any
   * ms->seconds conversion and clamping (see WorldRoom.update) -- this method takes
   * `dtSeconds` literally and passes it straight through to `crowd.update`.
   */
  tick(dtSeconds: number): AgentSnapshot[] {
    this.crowd.update(dtSeconds);

    const snapshots: AgentSnapshot[] = [];
    for (const [id, agent] of this.byId) {
      const pos = agent.position();
      const vel = agent.velocity();
      const speed = Math.hypot(vel.x, vel.z);

      let heading = this.lastHeading.get(id) ?? 0;
      if (speed >= MIN_HEADING_SPEED_MPS) {
        heading = Math.atan2(vel.x, vel.z);
        this.lastHeading.set(id, heading);
      }

      snapshots.push({ id, x: pos.x, z: pos.z, heading, speed });
    }
    return snapshots;
  }

  /** Releases the underlying WASM-backed Crowd. Call once this AgentCrowd is no longer
   * needed (e.g. room disposal in tests) so its native memory isn't leaked. */
  destroy(): void {
    this.crowd.destroy();
  }
}
