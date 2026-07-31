import type { VisitorHost } from "./visitors.js";
import { EscortManager } from "./escortManager.js";
import type { VisitorRecord } from "./escortManager.js";

/**
 * Deferred cleanup of Task 4.1's visitors.ts (flagged by that task's reviewer): this file
 * holds the simulated-visitor spawner + its lifecycle (spawn at the entrance, wait for a
 * robot, walk to its assigned room, dwell, walk back, despawn). It only touches
 * `EscortManager` (escortManager.ts) through that module's public surface --
 * `requestGuide` to start an escort, and `registerVisitor`/`allVisitors`/`removeVisitor`
 * to keep this spawner's own simulated records living in EscortManager's single shared
 * visitor map (see `VisitorRecord`'s doc comment in escortManager.ts for why there's only
 * one map instead of two that could drift apart). `visitors.ts`'s `VisitorManager` is the
 * thin composition root that constructs both this class and `EscortManager` and wires
 * `tick()` across both, in the order that matters -- see its doc comment.
 */

/** ~45 concurrent simulated visitors is the Phase 4 target headcount (matches
 * scripts/loadtest.ts's "50 robots + 45 visitors" 95-agent design point). Exported so
 * tests can reference the same number instead of a duplicated magic constant. */
export const SIMULATED_VISITOR_TARGET = 45;

/** Minimum gap between successive spawn attempts, in simulated seconds. This is what
 * staggers the initial ramp-up (spawning 45 visitors 0.5s apart takes ~22.5s of simulated
 * time to fill, instead of one instantaneous burst on tick 1) and also throttles retries
 * once at target. */
const SPAWN_STAGGER_INTERVAL_S = 0.5;

/** How often a visitor stuck in "waiting_for_robot" (spawned, but no idle robot was free
 * yet) retries `requestGuide`. Short enough that a robot freeing up gets noticed quickly,
 * long enough not to spam requestGuide's O(robots) scan every tick for every waiting visitor. */
const ROBOT_RETRY_INTERVAL_S = 1.0;

/** Randomized "look around the room" dwell time before a simulated visitor heads back to
 * the entrance. Short, per the task spec -- this is a demo, not a real dwell simulation.
 * NOTE: the dwell countdown is SEEDED by `EscortManager.endEscort` (escortManager.ts), the
 * instant an escort ends -- see that method's doc comment for why. This module only ticks
 * the countdown down on every subsequent frame and reacts once it expires. */
const DWELL_MIN_S = 3;
const DWELL_MAX_S = 8;

export interface SimulatedVisitorSpawnerOptions {
  /** Target concurrent simulated-visitor count. 0 disables the spawner entirely (useful
   * for tests that want to call `requestGuide` directly without the background spawner
   * competing for robots) while leaving `requestGuide` itself fully usable. Defaults to
   * `SIMULATED_VISITOR_TARGET`. */
  simulatedTarget?: number;
  spawnStaggerSeconds?: number;
  dwellMinSeconds?: number;
  dwellMaxSeconds?: number;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Maintains ~`simulatedTarget` concurrent simulated visitors and drives each one's
 * lifecycle end to end, delegating all guide-assignment/escort-binding/trailing work to
 * the injected `EscortManager`.
 */
export class SimulatedVisitorSpawner {
  private readonly host: VisitorHost;
  private readonly escorts: EscortManager;
  private readonly simulatedTarget: number;
  private readonly spawnStaggerS: number;
  private readonly dwellMinS: number;
  private readonly dwellMaxS: number;

  private spawnCooldownSeconds: number;
  private nextSimulatedId = 0;

  constructor(host: VisitorHost, escorts: EscortManager, options: SimulatedVisitorSpawnerOptions = {}) {
    this.host = host;
    this.escorts = escorts;
    this.simulatedTarget = options.simulatedTarget ?? SIMULATED_VISITOR_TARGET;
    this.spawnStaggerS = options.spawnStaggerSeconds ?? SPAWN_STAGGER_INTERVAL_S;
    this.dwellMinS = options.dwellMinSeconds ?? DWELL_MIN_S;
    this.dwellMaxS = options.dwellMaxSeconds ?? DWELL_MAX_S;

    // Stagger the very FIRST spawn too (not just subsequent ones) so a freshly-created
    // room doesn't burst all 45 in the same tick just because spawnCooldownSeconds started
    // at 0 -- see the "stagger initial spawns" requirement.
    this.spawnCooldownSeconds = this.simulatedTarget > 0 ? randomBetween(0, this.spawnStaggerS) : Infinity;
  }

  /** Count of `kind === "simulated"` records currently tracked (i.e. not yet despawned) --
   * this is the number Task 4.1's acceptance criteria calls "the concurrent count", and
   * what `VisitorManager.getDebugStats()` (visitors.ts) reports as `simulatedActive`. */
  countActiveSimulated(): number {
    let count = 0;
    for (const visitor of this.escorts.allVisitors()) {
      if (visitor.kind === "simulated") count++;
    }
    return count;
  }

  /**
   * Advances the spawner and every simulated visitor's lifecycle by `dtSeconds`. Call
   * ORDER within this method matters, for the same reason it did before this file split:
   * a visitor spawned this call (`tickSpawner`) shouldn't also have its (freshly seeded)
   * lifecycle cooldown immediately re-evaluated by `tickLifecycle` in the same pass.
   *
   * Must be called AFTER `EscortManager.tick()` within the same simulated frame -- see
   * `VisitorManager.tick()` in visitors.ts for the full ordering rationale.
   */
  tick(dtSeconds: number): void {
    this.tickSpawner(dtSeconds);
    this.tickLifecycle(dtSeconds);
  }

  /**
   * Spawns one simulated visitor at a time (never more than one per `spawnStaggerS`
   * window, which both staggers the initial ramp-up and throttles the "still below
   * target" retry rate) whenever the current simulated count is below target.
   */
  private tickSpawner(dtSeconds: number): void {
    if (this.simulatedTarget <= 0) return;

    this.spawnCooldownSeconds -= dtSeconds;
    if (this.spawnCooldownSeconds > 0) return;
    this.spawnCooldownSeconds = this.spawnStaggerS;

    if (this.countActiveSimulated() >= this.simulatedTarget) return;

    const id = `sim-visitor-${this.nextSimulatedId++}`;
    const spawn = { x: this.host.plan.entrance.point[0], z: this.host.plan.entrance.point[1] };
    this.host.addAgent(id, "visitor", spawn);

    const room = this.pickRandomRoom();
    const record: VisitorRecord = {
      id,
      kind: "simulated",
      robotId: null,
      escortElapsedSeconds: 0,
      escortSinceLastTrailUpdateSeconds: 0,
      robotPositionHistory: [],
      simulatedPhase: "waiting_for_robot",
      simulatedTargetRoom: room,
      simulatedCooldownSeconds: 0,
    };
    this.escorts.registerVisitor(record);

    this.tryStartEscort(record);
  }

  private pickRandomRoom(): string {
    const rooms = this.host.plan.rooms;
    return rooms[Math.floor(Math.random() * rooms.length)].name;
  }

  /** Attempts to bind a robot for a "waiting_for_robot" simulated visitor via the exact
   * same `requestGuide` a real Moses-driven assign would use. On failure (no idle robot
   * right now), stays in "waiting_for_robot" and arms a short retry cooldown instead of
   * despawning -- a spawned-but-not-yet-escorted visitor is still a "concurrent visitor"
   * for the purposes of the ~45-target headcount. */
  private tryStartEscort(record: VisitorRecord): void {
    const result = this.escorts.requestGuide(record.id, record.simulatedTargetRoom!);
    if (result) {
      record.simulatedPhase = "walking_to_room";
    } else {
      record.simulatedCooldownSeconds = ROBOT_RETRY_INTERVAL_S;
    }
  }

  /** Advances the non-escort parts of each simulated visitor's lifecycle:
   * "waiting_for_robot" retries requestGuide on cooldown; "dwelling" counts down then
   * sends the visitor walking back to the entrance (solo -- no robot needed to leave);
   * "walking_to_entrance" despawns once the visitor's own schema state settles back to
   * "idle" (the same settled-idle signal `EscortManager.tick()` uses for robot arrival,
   * applied here to the visitor's own agent instead of an escorting robot's).
   * "walking_to_room" is intentionally not handled here -- that phase is entirely driven
   * by `EscortManager.tick()` (which transitions it to "dwelling" on arrival/timeout). */
  private tickLifecycle(dtSeconds: number): void {
    for (const visitor of this.escorts.allVisitors()) {
      if (visitor.kind !== "simulated") continue;

      switch (visitor.simulatedPhase) {
        case "waiting_for_robot": {
          visitor.simulatedCooldownSeconds -= dtSeconds;
          if (visitor.simulatedCooldownSeconds <= 0) this.tryStartEscort(visitor);
          break;
        }

        case "dwelling": {
          visitor.simulatedCooldownSeconds -= dtSeconds;
          if (visitor.simulatedCooldownSeconds <= 0) {
            visitor.simulatedPhase = "walking_to_entrance";
            const entrance = {
              x: this.host.plan.entrance.point[0],
              z: this.host.plan.entrance.point[1],
            };
            const ok = this.host.moveAgentTo(visitor.id, entrance);
            if (!ok) {
              // The entrance should always be reachable; don't strand the visitor forever
              // if it somehow isn't.
              console.warn(
                `SimulatedVisitorSpawner: could not route simulated visitor "${visitor.id}" back to the entrance; despawning`,
              );
              this.despawn(visitor.id);
            }
          }
          break;
        }

        case "walking_to_entrance": {
          const agent = this.host.agents.get(visitor.id);
          if (agent && agent.state === "idle") this.despawn(visitor.id);
          break;
        }

        case "walking_to_room":
        default:
          break;
      }
    }
  }

  /** Removes a simulated visitor entirely (both the Crowd/schema agent via the host, and
   * EscortManager's bookkeeping), freeing its spawn slot for a fresh visitor on a later
   * `tickSpawner` call. */
  private despawn(visitorId: string): void {
    this.escorts.removeVisitor(visitorId);
    this.host.removeAgent(visitorId);
  }
}
