import type { MapSchema } from "@colyseus/schema";

import type { Agent } from "./schema/WorldState.js";
import type { BuiltNavMesh, RoomTarget } from "../nav/buildNavMesh.js";
import type { FloorPlan } from "../nav/loadFloorPlan.js";
import { EscortManager } from "./escortManager.js";
import { SimulatedVisitorSpawner } from "./simulatedVisitorSpawner.js";
import type { SimulatedVisitorSpawnerOptions } from "./simulatedVisitorSpawner.js";

/**
 * Task 4.1: server-side simulated-visitor spawner + guide-assignment bookkeeping,
 * factored out of WorldRoom.ts so that file doesn't sprawl. WorldRoom owns one
 * `VisitorManager` instance and:
 *   - exposes its own `requestGuide()` as a one-line passthrough to this module's
 *     `requestGuide()` (the plan requires the PUBLIC method to live on WorldRoom; the
 *     bookkeeping/logic behind it lives here).
 *   - calls `tick(dtSeconds)` once per `WorldRoom.update()`, AFTER the crowd tick + schema
 *     sync (see the ordering note on `tick()` below -- it's load-bearing for arrival
 *     detection, not just a style choice).
 *
 * This file is the thin composition root for the visitor subsystem (split out of a single
 * 569-line file as deferred cleanup flagged by Task 4.1's reviewer -- the original bundled
 * three jobs that didn't all belong in one place):
 *   - `escortManager.ts`'s `EscortManager` -- assignment/binding bookkeeping and the
 *     trailing-follow physics, tightly coupled through the escort tick loop.
 *   - `simulatedVisitorSpawner.ts`'s `SimulatedVisitorSpawner` -- the simulated-visitor
 *     spawn/dwell/despawn lifecycle, which only depends on `EscortManager`'s public
 *     surface (`requestGuide` + the read-only visitor-registration/iteration methods).
 * `VisitorManager` below just constructs both (in that dependency order) and forwards
 * `requestGuide`/`getDebugStats`/`tick` to the pair -- see each class's own file for the
 * logic previously described here.
 *
 * `VisitorHost` is the narrow slice of WorldRoom this subsystem needs: the already-built
 * nav/plan (read-only, stable for the room's lifetime), the live synced agents map, and
 * three callbacks that route back through WorldRoom's own `addAgent`/`removeAgent`/
 * `moveAgentTo` (so the "both the Crowd and the schema move together" invariant those
 * methods already enforce isn't duplicated here) plus a raw `requestMoveTarget` for the
 * visitor-trailing case, which deliberately bypasses `moveAgentTo` -- see
 * `EscortManager`'s `recordHistoryAndRetarget`. It's defined once, here, and shared by
 * both `escortManager.ts` and `simulatedVisitorSpawner.ts` rather than split into two
 * narrower interfaces -- both need most of it (agents + moveAgentTo overlap already), and
 * a single shared contract is what WorldRoom.ts builds one object literal against.
 */
export interface VisitorHost {
  readonly plan: FloorPlan;
  readonly nav: BuiltNavMesh;
  readonly agents: MapSchema<Agent>;
  /** Returns `false` (adds nothing) if the world is already at MAX_AGENTS -- see
   * `WorldRoom.addAgent`'s doc comment. `simulatedVisitorSpawner.ts`'s spawner checks
   * this and skips the spawn attempt for the tick rather than registering a visitor
   * record for an agent that was never actually added. */
  addAgent(id: string, kind: "robot" | "visitor", spawn: { x: number; z: number }): boolean;
  removeAgent(id: string): void;
  moveAgentTo(agentId: string, roomNameOrCoords: string | RoomTarget): boolean;
  requestMoveTarget(agentId: string, target: { x: number; z: number }): boolean;
}

export interface VisitorManagerOptions extends SimulatedVisitorSpawnerOptions {
  escortTimeoutSeconds?: number;
}

export interface VisitorDebugStats {
  /** Every visitor this module is currently tracking (simulated + real). */
  totalVisitors: number;
  /** Visitors with `kind === "simulated"` currently tracked (i.e. not yet despawned) --
   * this is the number Task 4.1's acceptance criteria calls "the concurrent count". */
  simulatedActive: number;
  /** Visitors currently bound to a robot (forward count, from visitor records). */
  escortedVisitors: number;
  /** Robots currently bound to a visitor (reverse-map count). Should always equal
   * `escortedVisitors` -- if it doesn't, the two sides of the binding have drifted, which
   * would mean a robot is (or isn't) escorting without a matching visitor-side record. */
  robotBindings: number;
}

/**
 * Composition root: owns one `EscortManager` and one `SimulatedVisitorSpawner`, wired
 * together (the spawner takes the escort manager as its assignment dependency), and
 * forwards WorldRoom's public surface to whichever of the two actually owns it.
 */
export class VisitorManager {
  private readonly escorts: EscortManager;
  private readonly spawner: SimulatedVisitorSpawner;

  constructor(host: VisitorHost, options: VisitorManagerOptions = {}) {
    this.escorts = new EscortManager(host, {
      escortTimeoutSeconds: options.escortTimeoutSeconds,
      dwellMinSeconds: options.dwellMinSeconds,
      dwellMaxSeconds: options.dwellMaxSeconds,
    });
    this.spawner = new SimulatedVisitorSpawner(host, this.escorts, {
      simulatedTarget: options.simulatedTarget,
      spawnStaggerSeconds: options.spawnStaggerSeconds,
      dwellMinSeconds: options.dwellMinSeconds,
      dwellMaxSeconds: options.dwellMaxSeconds,
    });
  }

  /** Passthrough to `EscortManager.requestGuide` -- see its doc comment in
   * escortManager.ts for the full assignment logic. */
  requestGuide(visitorId: string, roomNameOrCoords: string | RoomTarget): { robotId: string } | null {
    return this.escorts.requestGuide(visitorId, roomNameOrCoords);
  }

  /** Merges `EscortManager`'s escort-binding stats with `SimulatedVisitorSpawner`'s
   * simulated-visitor count -- see `VisitorDebugStats`'s doc comments for what each field
   * means. */
  getDebugStats(): VisitorDebugStats {
    const escortStats = this.escorts.getDebugStats();
    return {
      totalVisitors: escortStats.totalVisitors,
      simulatedActive: this.spawner.countActiveSimulated(),
      escortedVisitors: escortStats.escortedVisitors,
      robotBindings: escortStats.robotBindings,
    };
  }

  /**
   * Advances everything this subsystem owns by `dtSeconds` of simulated time. Call ORDER
   * matters, and so does WHEN the caller invokes `tick()` relative to its own crowd step:
   *
   *   1. `EscortManager.tick()` first, so an escort bound on a PREVIOUS call is evaluated
   *      against agent state that has already had at least one real crowd tick applied to
   *      it since binding (WorldRoom.update() calls `crowd.tick()` + syncs schema state
   *      BEFORE calling this method -- see WorldRoom.ts). That ordering is what makes
   *      "robot schema state settled back to idle" a safe, race-free arrival signal on its
   *      own: a robot can never go idle -> (bound this call) -> re-checked-idle within the
   *      SAME tick(), because binding happens in step 2, AFTER this step already ran.
   *   2. `SimulatedVisitorSpawner.tick()` -- internally spawns/binds first (may bind a NEW
   *      escort via `requestGuide`, called with a target robot that is schema-idle right
   *      now; its arrival won't be (mis)checked until the NEXT tick() call, by which point
   *      a real crowd tick has run -- see (1)), then advances the rest of each simulated
   *      visitor's lifecycle -- so a visitor that JUST started dwelling (via step 1 ending
   *      its escort this same call) doesn't also immediately re-evaluate its (freshly
   *      reset) dwell cooldown in the same pass before the spawn step has had a chance to
   *      run. See `SimulatedVisitorSpawner.tick`'s own doc comment for that inner ordering.
   */
  tick(dtSeconds: number): void {
    this.escorts.tick(dtSeconds);
    this.spawner.tick(dtSeconds);
  }
}
