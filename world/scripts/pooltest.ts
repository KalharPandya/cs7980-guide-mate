/**
 * Wire-level regression guard for the `agentPool` fix (commit d1dcaae, see WorldRoom.ts's
 * `addAgent`/`removeAgent` doc comments): pooling reuses `Agent` schema instances across
 * spawn/despawn cycles instead of `new Agent()`-ing forever, which is what closed a real
 * @colyseus/schema 4.0.30 encoder leak (soaktest.ts). The risk that fix introduces --
 * flagged by static review, never proven end to end until this script -- is that a pooled
 * instance keeps its schema refId, so on the wire a client can see the same refId removed
 * from one map key and later re-added under a DIFFERENT key. `AgentSnapshot.route`
 * (world-client/src/net/useWorldRoom.ts) is deliberately the LIVE `ArraySchema` reference
 * (not a re-synced copy), specifically so RouteLine.tsx can poll it every frame -- making
 * it exactly the field a pooled instance also recycles. If pooling ever let one route
 * object be simultaneously "owned" by two live agent keys, the visible symptom would be a
 * robot drawing another robot's route line, or a stale route persisting after respawn.
 *
 * This is NOT a `new WorldRoom()` unit test (that pattern skips `Room#__init()` -- see
 * soaktest.ts's file header for why that matters for schema encoding). It boots a REAL
 * `colyseus` `Server` + `WebSocketTransport` on a throwaway port, pre-creates the room via
 * `matchMaker.createRoom()` (mirrors world/src/index.ts and persistence.test.ts), and
 * connects a REAL `@colyseus/sdk` `Client` over an actual WebSocket. The client-side
 * subscription logic is a deliberate line-for-line mirror of `useWorldRoom.ts`: same
 * `getStateCallbacks`, same fresh-plain-object snapshot built in `onAdd`, same "keep
 * `route` as the live ArraySchema reference" decision, same scalar-field sync in
 * `onChange`, same `Map.delete` in `onRemove` -- because the whole point is to prove THAT
 * exact consumption pattern stays correct under real pooled-instance churn, not a
 * simplified stand-in for it.
 *
 * ---- what it drives ----
 * Real guide-robot fleet (GUIDE_ROBOT_COUNT, unchanged) so simulated visitors always have
 * an idle robot to escort them (the pool only churns via visitor spawn/despawn -- robots
 * are seeded once at boot and never removed, see WorldRoom.ts). `visitorManagerOptions`
 * (the same injectable test hook soaktest.ts uses) compresses spawn-stagger/dwell timing
 * well below shipped defaults and lowers `simulatedTarget` from the real 45 to
 * `SIMULATED_TARGET` below, purely so a bounded pool cycles through many more full
 * spawn-to-despawn-to-respawn generations inside a short, real-wall-clock test run --
 * shipped defaults (simulatedVisitorSpawner.ts) are untouched, and walking speed/distance
 * is NOT compressed (agents walk the real navmesh at DEFAULT_AGENT_PARAMS.maxSpeed), same
 * "compress waiting, not simulation" convention as soaktest.ts.
 *
 * Unlike soaktest.ts, simulated time here is NOT hand-driven tick-by-tick: this needs REAL
 * patch broadcasts to flow over an ACTUAL WebSocket to prove the wire-level behavior, so
 * the room's own real `setSimulationInterval`/patchRate timers are left running and this
 * script just waits out real wall-clock seconds (`RUN_SECONDS`).
 *
 * ---- how "refIds are being recycled" is actually proven ----
 * Two independent, complementary checks, not just an assertion that trusts the fix worked:
 *
 * 1. SERVER-SIDE (authoritative, quantitative): `WorldRoom.prototype.addAgent` is
 *    call-spied (records a call, then delegates to the real implementation unchanged --
 *    this observes, it does not alter, pooling behavior). After every successful call, the
 *    spy reads the just-(re)added `Agent` instance's own `[$refId]` (a public, typed
 *    `@colyseus/schema` symbol -- see Schema.d.ts's `[$refId]?: number` -- not a private
 *    hack). If pooling is working, hundreds of addAgent calls should resolve to a small,
 *    bounded SET of distinct refId values (robots each mint one refId once at boot and
 *    keep it forever; visitors cycle through at most `SIMULATED_TARGET` refIds for the
 *    whole run). This script asserts exactly that gap and prints the raw numbers. As a
 *    second, independent cross-check using the exact mechanism soaktest.ts's own root-cause
 *    writeup documents (WorldRoom.ts's `addAgent` doc comment): `@colyseus/schema`'s
 *    encoder-side `Root.refCount` (reached the same private-but-runtime-public way
 *    soaktest.ts reaches `Room#__init()`, via `room._serializer.encoder.root`) only ever
 *    GROWS its key count when a genuinely NEW `new Agent()` is registered -- a reused
 *    instance re-added under a new key does not add a new key to it. This script samples
 *    `Object.keys(root.refCount).length` once after the initial ramp-up settles and once
 *    at the end, and asserts the growth across the whole churn window is small, independent
 *    of how many visitor spawn/despawn cycles happened in between.
 *
 * 2. CLIENT-SIDE (corroborating, observed over the real wire): the client's own `onAdd`
 *    records, per route object identity, every map key that has ever owned it. If the
 *    decoder ever reconstructs the SAME local `route` object for two different keys (which
 *    a quick standalone protocol experiment during this task confirmed DOES happen when a
 *    server-side remove+re-add of the same pooled instance/refId lands inside a single
 *    unflushed patch -- see this file's own printed `CLIENT-OBSERVED REUSE` count), that is
 *    direct proof the wire itself is exercising the exact risk this script exists to catch,
 *    not merely the server's internal bookkeeping.
 *
 *    A separate, related finding from that same investigation, worth calling out so it
 *    isn't mistaken for a bug when the numbers below don't add up: `simulatedVisitorSpawner
 *    .ts`'s `freeSlotIds` and `WorldRoom.ts`'s `agentPool` are both LIFO and are pushed
 *    together inside the SAME `despawn()` call, so the overwhelmingly common case is a
 *    SAME map key (e.g. "sim-visitor-4") being removed and immediately re-added for a
 *    DIFFERENT logical visitor. When that same-key remove+add lands inside one unflushed
 *    patch (confirmed with millisecond-precision server/client event tracing while building
 *    this script), the decoder does not fire onRemove/onAdd for it AT ALL -- the key just
 *    silently stays present, and the client's `onAddEvents`/`onRemoveEvents` counters below
 *    will be lower than the server's `addAgent`/`removeAgent` call counts. This is benign
 *    for this exact schema (verified, not assumed): `id`/`kind` are always re-set to match
 *    the key regardless of which occupant is present, and `x`/`z`/`heading`/`state`/`route`
 *    all stay correctly synced through the skip via `onChange` and the live reference --
 *    so no stale or wrong data is ever actually visible, only a "missing" event pair. It is
 *    ALSO, notably, not the risk this script is chasing: the key never changes, so it can't
 *    produce cross-key aliasing. The DECORRELATOR below exists specifically to force the
 *    less-common CROSS-key case (a different map key inheriting a just-freed instance) on
 *    top of whatever natural same-key churn happens, so this script doesn't just get lucky
 *    on timing for the risk that actually matters.
 *
 * ---- invariants checked (every ~SAMPLE_INTERVAL_MS, plus incrementally on every onAdd) ----
 *  - No two distinct LIVE agent keys ever have snapshot.route pointing at the same object
 *    (checked two ways: incrementally in onAdd via a route->currentOwner map, AND by a full
 *    sweep of the live snapshot map every sample -- belt and suspenders).
 *  - Immediately after every `addAgent` call (server-side, at the exact call boundary,
 *    BEFORE any same-tick `moveAgentTo` push can run) the (possibly reused) instance's
 *    `route.length === 0` -- this is what `addAgent`'s own `agent.route.clear()` is
 *    supposed to guarantee, checked deterministically rather than by racing the wire (a
 *    wire-level "empty at onAdd" assertion is NOT reliable: a visitor's escort can be
 *    assigned and its route pushed in the SAME simulation tick as its spawn, so the
 *    client's `onAdd` can legitimately observe an already-non-empty, freshly-correct route
 *    -- confirmed with a standalone protocol experiment while building this script).
 *  - Every live snapshot's `id` field equals its map key.
 *  - `route.length` is always even (well-formed x,z pairs).
 *  - Client-mirrored agent count matches `room.state.agents.size` (the real server-side
 *    authoritative count) at every sample, and the two key sets match exactly.
 *  - Weak position-aliasing signal (logged, not asserted -- coincident positions are
 *    EXPECTED at the shared entrance spawn point, so a hard failure here would be a false
 *    alarm generator, not a real check): informational count only.
 *
 * Run with: npm run test:pool   (== npx tsx scripts/pooltest.ts)
 * Configurable via env vars (all optional): POOL_TEST_PORT, POOL_TEST_RUN_SECONDS,
 * POOL_TEST_SIMULATED_TARGET.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";
import { Server, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import { $refId } from "@colyseus/schema";

import { WorldRoom, GUIDE_ROBOT_COUNT } from "../src/rooms/WorldRoom.js";
import { loadFloorPlan } from "../src/nav/loadFloorPlan.js";

const TEST_PORT = Number(process.env.POOL_TEST_PORT) || 24771; // throwaway port, not 2567

/** Real wall-clock seconds -- this test needs ACTUAL patch broadcasts over an ACTUAL
 * WebSocket (see file header), so simulated time cannot be hand-driven the way
 * soaktest.ts's ticks are; every second here really elapses. */
const RUN_SECONDS = Number(process.env.POOL_TEST_RUN_SECONDS ?? 90);

/** Lowered from the real SIMULATED_VISITOR_TARGET (45) purely to get many more full
 * spawn/despawn generations through a SMALL, bounded pool inside RUN_SECONDS of real time
 * -- an injectable per-test override (visitorManagerOptions), not a change to the shipped
 * default. */
const SIMULATED_TARGET = Number(process.env.POOL_TEST_SIMULATED_TARGET ?? 16);

const COMPRESSED_SPAWN_STAGGER_S = 0.1;
const COMPRESSED_DWELL_MIN_S = 0.2;
const COMPRESSED_DWELL_MAX_S = 0.6;

const SAMPLE_INTERVAL_MS = 300;

/** How long after boot to capture the encoder refCount baseline -- long enough that the
 * initial ramp-up to SIMULATED_TARGET has finished minting its (expected, one-time) fresh
 * refIds, so the baseline->final delta measures CHURN only, not legitimate initial growth. */
const BASELINE_SETTLE_MS = 5000;

/** Regression floor: below this many visitor spawn/despawn cycles, the run hasn't actually
 * exercised the pool enough to say anything -- fail loudly instead of reporting a
 * false "no corruption found". */
const MIN_VISITOR_SPAWNS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors world-client/src/net/useWorldRoom.ts's `AgentSnapshot` exactly -- see that
 * file's doc comment for why `route` is the live ArraySchema reference, not a copy. */
interface AgentSnapshot {
  id: string;
  kind: string;
  x: number;
  z: number;
  heading: number;
  state: string;
  route: ArrayLike<number>;
}

/** Reaches `@colyseus/core`'s `Room#_serializer` -- a normal runtime-enumerable property
 * that only TypeScript's `.d.ts` marks private (verified: no `#` private-field syntax in
 * the installed colyseus 0.17.10's Room.mjs) -- the exact same "TS-private, runtime-public"
 * escape hatch soaktest.ts documents and uses for `Room#__init()`. `Root.refCount`/
 * `Root.changeTrees` are PUBLIC on `@colyseus/schema`'s `Root` class (Root.d.ts); only
 * reading them here, exactly like soaktest.ts's own introspection convention. */
function getEncoderRefCountKeyCount(room: WorldRoom): number {
  const anyRoom = room as unknown as {
    _serializer: { encoder: { root: { refCount: Record<number, number> } } };
  };
  return Object.keys(anyRoom._serializer.encoder.root.refCount).length;
}

async function main(): Promise<void> {
  const plan = loadFloorPlan();
  const entrance = { x: plan.entrance.point[0], z: plan.entrance.point[1] };

  // ---- server-side call-spy on addAgent/removeAgent: OBSERVES pooling, does not alter it.
  // Each spy delegates to the real implementation unchanged, then records what happened. ----
  let addAgentCallCount = 0;
  let removeAgentCallCount = 0;
  const agentRefIdsAssigned: number[] = [];
  const routeNotClearedOnAddFailures: string[] = [];

  const originalAddAgent = WorldRoom.prototype.addAgent;
  WorldRoom.prototype.addAgent = function (
    this: WorldRoom,
    id: string,
    kind: "robot" | "visitor",
    spawn: { x: number; z: number },
  ): boolean {
    addAgentCallCount++;
    const added = originalAddAgent.call(this, id, kind, spawn);
    if (added) {
      const agent = this.state.agents.get(id);
      if (agent) {
        const refId = agent[$refId];
        if (typeof refId === "number") agentRefIdsAssigned.push(refId);
        // Checked HERE, at the exact call boundary, deterministically -- see file header
        // for why a wire-level "empty at onAdd" check is not reliable (a same-tick
        // moveAgentTo push is legitimate), but this server-side check catches the real
        // risk precisely: a reused instance must never carry over its previous
        // occupant's route past this point.
        if (agent.route.length !== 0) {
          routeNotClearedOnAddFailures.push(
            `addAgent("${id}") left route.length=${agent.route.length} immediately after add ` +
              `(refId=${String(refId)}) -- agentPool reuse did not clear a previous occupant's route`,
          );
        }
      }
    }
    return added;
  };

  const originalRemoveAgent = WorldRoom.prototype.removeAgent;
  WorldRoom.prototype.removeAgent = function (this: WorldRoom, id: string): void {
    removeAgentCallCount++;
    originalRemoveAgent.call(this, id);
  };

  const app = express();
  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    greet: false,
  });
  const handler = gameServer.define("world", WorldRoom);

  let serverRoom: WorldRoom | undefined;
  handler.on("create", (room) => {
    serverRoom = room as WorldRoom;
  });

  const failures: string[] = [];
  const logFailure = (msg: string): void => {
    failures.push(msg);
    console.error(`CORRUPTION: ${msg}`);
  };

  // Declared here (not inside `try`) so the `finally` block can always clear it, even if an
  // assertion throws before the run reaches its own explicit clearInterval call below --
  // otherwise a dangling timer would keep calling room.addAgent/removeAgent after
  // gracefullyShutdown() and keep the process alive past its intended exit.
  let decorrelatorTimer: ReturnType<typeof setInterval> | undefined;

  try {
    await gameServer.listen(TEST_PORT);

    // Eager boot-time creation, mirroring world/src/index.ts and persistence.test.ts.
    await matchMaker.createRoom("world", {
      visitorManagerOptions: {
        simulatedTarget: SIMULATED_TARGET,
        spawnStaggerSeconds: COMPRESSED_SPAWN_STAGGER_S,
        dwellMinSeconds: COMPRESSED_DWELL_MIN_S,
        dwellMaxSeconds: COMPRESSED_DWELL_MAX_S,
      },
    });
    assert.ok(serverRoom, "matchMaker.createRoom should have handed us the WorldRoom instance via 'create'");
    const room = serverRoom!;

    console.log(
      `Plan: ${RUN_SECONDS}s real wall-clock, ${GUIDE_ROBOT_COUNT} guide robots (default fleet), ` +
        `simulatedTarget=${SIMULATED_TARGET} (real default 45, compressed for this test), ` +
        `spawnStagger=${COMPRESSED_SPAWN_STAGGER_S}s dwell=${COMPRESSED_DWELL_MIN_S}-${COMPRESSED_DWELL_MAX_S}s ` +
        `(real defaults 0.5s / 3-8s) -- walking speed/distance NOT compressed.\n`,
    );

    // ---- real @colyseus/sdk client, mirroring useWorldRoom.ts's connection shape ----
    const client = new Client(`ws://localhost:${TEST_PORT}`);
    const clientRoom: Room = await client.joinOrCreate("world", {});

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for initial state")), 5000);
      clientRoom.onStateChange.once(() => {
        clearTimeout(t);
        resolve();
      });
    });

    // ---- client-side mirror of useWorldRoom.ts's agentsRef, built the SAME way ----
    const agents = new Map<string, AgentSnapshot>();
    const routeOwner = new Map<ArrayLike<number>, string>();
    const routeEverOwners = new Map<ArrayLike<number>, Set<string>>();
    let onAddEvents = 0;
    let onRemoveEvents = 0;

    const $ = getStateCallbacks(clientRoom);
    $(clientRoom.state as never).agents.onAdd((agent: never, key: string) => {
      const a = agent as {
        id: string;
        kind: string;
        x: number;
        z: number;
        heading: number;
        state: string;
        route: ArrayLike<number>;
      };
      onAddEvents++;

      // Headline invariant, checked incrementally at the moment of add: this route object
      // must not currently be owned by a DIFFERENT still-live key.
      const currentOwner = routeOwner.get(a.route);
      if (currentOwner !== undefined && currentOwner !== key && agents.has(currentOwner)) {
        logFailure(
          `ALIASING at onAdd: route object added under key "${key}" is still owned by live key "${currentOwner}" ` +
            `(route content now: [${Array.from(a.route).join(",")}])`,
        );
      }
      routeOwner.set(a.route, key);
      if (!routeEverOwners.has(a.route)) routeEverOwners.set(a.route, new Set());
      routeEverOwners.get(a.route)!.add(key);

      const snapshot: AgentSnapshot = {
        id: a.id,
        kind: a.kind,
        x: a.x,
        z: a.z,
        heading: a.heading,
        state: a.state,
        route: a.route,
      };
      agents.set(key, snapshot);

      $(agent).onChange(() => {
        const s = agents.get(key);
        if (s) {
          s.x = a.x;
          s.z = a.z;
          s.heading = a.heading;
          s.state = a.state;
        }
      });
    });

    $(clientRoom.state as never).agents.onRemove((_agent: never, key: string) => {
      onRemoveEvents++;
      const s = agents.get(key);
      if (s && routeOwner.get(s.route) === key) routeOwner.delete(s.route);
      agents.delete(key);
    });

    // >= not === : the room is pre-created (matchMaker.createRoom) and its real timers are
    // already running before the client ever joins (same "world persistence" behavior
    // world/src/index.ts relies on), so by the time this client's first patch arrives the
    // spawner may already have added a visitor or two on top of the guide fleet -- matches
    // persistence.test.ts's own ">=" convention for the same reason.
    assert.ok(
      agents.size >= GUIDE_ROBOT_COUNT,
      `client should have mirrored at least the initial ${GUIDE_ROBOT_COUNT}-robot guide fleet, got ${agents.size}`,
    );
    console.log(`PASS: client mirrored the initial guide fleet via onAdd (${agents.size} agents at first sync, >= ${GUIDE_ROBOT_COUNT})`);

    // ---- full-map sweep, run every sample: independent second line of defense beyond the
    // incremental onAdd check above ----
    function sweepInvariants(label: string): void {
      const seenRoutes = new Map<ArrayLike<number>, string>();
      for (const [key, snap] of agents) {
        const owner = seenRoutes.get(snap.route);
        if (owner !== undefined) {
          logFailure(
            `ALIASING at ${label}: keys "${owner}" and "${key}" currently share the same route object identity`,
          );
        } else {
          seenRoutes.set(snap.route, key);
        }
        if (snap.id !== key) {
          logFailure(`ID MISMATCH at ${label}: key "${key}" has snapshot.id="${snap.id}"`);
        }
        if (snap.route.length % 2 !== 0) {
          logFailure(`ODD ROUTE LENGTH at ${label}: key "${key}" route.length=${snap.route.length}`);
        }
      }
    }

    // ---- weak position-aliasing signal: informational only, see file header for why this
    // is deliberately NOT a hard assertion (coincident positions at the shared entrance
    // spawn point are expected, not suspicious) ----
    let maxCoincidentGroupSize = 1;
    let coincidentSampleHits = 0;
    function scanPositionCoincidence(): void {
      const buckets = new Map<string, string[]>();
      for (const [key, snap] of agents) {
        const bucketKey = `${snap.x.toFixed(2)},${snap.z.toFixed(2)}`;
        const arr = buckets.get(bucketKey);
        if (arr) arr.push(key);
        else buckets.set(bucketKey, [key]);
      }
      for (const [bucketKey, keys] of buckets) {
        if (keys.length <= 1) continue;
        const [bx, bz] = bucketKey.split(",").map(Number);
        const nearEntrance = Math.hypot(bx - entrance.x, bz - entrance.z) < 1.5;
        if (nearEntrance) continue; // expected: shared spawn point
        coincidentSampleHits++;
        if (keys.length > maxCoincidentGroupSize) maxCoincidentGroupSize = keys.length;
      }
    }

    // ---- "decorrelator": deliberately exercises CROSS-key reuse, not just same-key ----
    // A standalone protocol experiment while building this script (see git history / task
    // notes) found that when the SAME map key is removed and re-added within one unflushed
    // patch (the common case here: `simulatedVisitorSpawner.ts`'s `freeSlotIds` and
    // `WorldRoom.ts`'s `agentPool` are both LIFO and are pushed together, in the same
    // `despawn()` call, so the very next spawn usually drains the SAME slot id together
    // with the SAME just-freed Agent instance), the decoder does not fire a discrete
    // onRemove+onAdd pair at all for that hop -- it is invisible on the wire, and harmless
    // for THIS schema (id/kind are always re-set to match the key regardless of which
    // occupant is present, and x/z/heading/state/route all stay correctly synced via
    // onChange / the live reference regardless). That is a real, confirmed finding, but it
    // is NOT the risk this script exists to catch -- the task's headline risk is a pooled
    // instance's route object handed to a DIFFERENT key while still observably live under
    // its old one. To actually exercise THAT path (not just get lucky/unlucky on natural
    // timing), this injects a fixed extra key ("decorrelator-visitor", mirroring how the
    // IoT bridge spawns a real, non-simulated visitor -- world/src/iot/bridge.ts's `assign`
    // handler calls `room.addAgent` directly, exactly like this does) on its own short
    // cadence, deliberately decorrelating `agentPool`'s LIFO order from `freeSlotIds`' LIFO
    // order: whichever instance THIS releases back to the pool is now up for grabs by
    // whatever simulated-visitor spawn happens to run next, under a completely different
    // key. Runs concurrently with the rest of the churn for the whole main run below.
    const DECORRELATOR_ID = "decorrelator-visitor";
    const DECORRELATOR_INTERVAL_MS = 700;
    let decorrelatorCycles = 0;
    decorrelatorTimer = setInterval(() => {
      if (room.state.agents.has(DECORRELATOR_ID)) {
        room.removeAgent(DECORRELATOR_ID);
      } else {
        room.addAgent(DECORRELATOR_ID, "visitor", entrance);
      }
      decorrelatorCycles++;
    }, DECORRELATOR_INTERVAL_MS);

    // ---- baseline encoder refCount, captured after the initial ramp-up settles ----
    await sleep(BASELINE_SETTLE_MS);
    sweepInvariants("baseline");
    const refCountKeysBaseline = getEncoderRefCountKeyCount(room);
    const addAgentCallsAtBaseline = addAgentCallCount;
    console.log(
      `Baseline (after ${BASELINE_SETTLE_MS}ms settle): addAgent calls=${addAgentCallsAtBaseline}, ` +
        `distinct refIds assigned so far=${new Set(agentRefIdsAssigned).size}, ` +
        `encoder root.refCount key count=${refCountKeysBaseline}, live agents=${room.state.agents.size}\n`,
    );

    // ---- main run: periodic sample + sweep for the remainder of RUN_SECONDS ----
    // Count-comparison note: the world is CONTINUOUSLY live during this loop (real
    // spawns/despawns keep happening on the room's own real timers while this samples), so
    // `agents.size` (client, decoded from the last patch that has arrived) and
    // `room.state.agents.size` (server, truth as of THIS instant) are reads of a moving
    // target taken from two different clocks -- a small, transient, non-repeating skew is
    // ordinary patch-broadcast replication lag, not corruption. A tolerant threshold plus a
    // "does it ever resolve back to 0" check (persistent/growing divergence would be a real
    // leak) is what actually distinguishes lag from a bug; a bare `sleep()`-then-recheck
    // (this script's first draft) does NOT, because the world keeps mutating during the
    // sleep too, so recheck is just resampling a still-moving target. The strict,
    // lag-free comparison happens once below, after `room.pause()` makes the target hold still.
    const COUNT_MISMATCH_TOLERANCE = 2;
    const MAX_CONSECUTIVE_NONZERO_MISMATCH_SAMPLES = 5;
    let consecutiveNonZeroMismatchSamples = 0;

    const remainingMs = Math.max(0, RUN_SECONDS * 1000 - BASELINE_SETTLE_MS);
    const startedAtMs = Date.now();
    let lastLogMs = 0;
    while (Date.now() - startedAtMs < remainingMs) {
      await sleep(SAMPLE_INTERVAL_MS);
      sweepInvariants("sample");
      scanPositionCoincidence();

      const clientCount = agents.size;
      const serverCount = room.state.agents.size;
      const mismatch = Math.abs(clientCount - serverCount);
      if (mismatch === 0) {
        consecutiveNonZeroMismatchSamples = 0;
      } else {
        consecutiveNonZeroMismatchSamples++;
        if (mismatch > COUNT_MISMATCH_TOLERANCE) {
          logFailure(
            `COUNT MISMATCH: client mirrored ${clientCount} agents, server has ${serverCount} ` +
              `(diff=${mismatch}, over the ${COUNT_MISMATCH_TOLERANCE}-agent replication-lag tolerance)`,
          );
        } else if (consecutiveNonZeroMismatchSamples > MAX_CONSECUTIVE_NONZERO_MISMATCH_SAMPLES) {
          logFailure(
            `COUNT MISMATCH: client (${clientCount}) vs server (${serverCount}) has not resolved back to 0 for ` +
              `${consecutiveNonZeroMismatchSamples} consecutive samples -- persistent divergence, not transient lag`,
          );
        }
      }

      const elapsedS = (Date.now() - startedAtMs + BASELINE_SETTLE_MS) / 1000;
      if (Date.now() - lastLogMs >= 5000) {
        lastLogMs = Date.now();
        console.log(
          `t=${elapsedS.toFixed(0)}s | addAgent calls=${addAgentCallCount} (visitors=${addAgentCallCount - GUIDE_ROBOT_COUNT}) ` +
            `removeAgent calls=${removeAgentCallCount} | distinct refIds=${new Set(agentRefIdsAssigned).size} | ` +
            `client agents=${clientCount} server agents=${serverCount} | failures=${failures.length}`,
        );
      }
    }

    // Stop the decorrelator BEFORE pausing/settling so its own add/remove calls can't race
    // the final comparison below (if it's mid-cycle with the agent present, that's fine --
    // it just becomes one more ordinary live agent both sides must agree on).
    clearInterval(decorrelatorTimer);
    decorrelatorTimer = undefined;
    console.log(`Decorrelator ran ${decorrelatorCycles} add/remove cycles, injecting cross-key pool churn.`);

    // ---- freeze the world (WorldRoom.pause(), a real public API -- see its doc comment:
    // skips the Crowd tick AND VisitorManager.tick(), so no further schema mutations can
    // happen), THEN settle any already-in-flight patch, THEN do a final STRICT comparison
    // against a target that is actually holding still -- this is what makes the final
    // check lag-free, unlike the tolerant/streak-based check during the live run above. ----
    room.pause();
    console.log("\nPaused the room (no further spawns/despawns/movement) for a lag-free final comparison.");
    await sleep(500);
    sweepInvariants("final");

    const finalClientKeys = new Set(agents.keys());
    const finalServerKeys = new Set(room.state.agents.keys());
    assert.equal(
      finalClientKeys.size,
      finalServerKeys.size,
      `final key-set size mismatch: client=${finalClientKeys.size}, server=${finalServerKeys.size}`,
    );
    for (const k of finalServerKeys) {
      assert.ok(finalClientKeys.has(k), `final key set: server has "${k}" but client's mirror does not`);
    }
    for (const k of finalClientKeys) {
      assert.ok(finalServerKeys.has(k), `final key set: client's mirror has "${k}" but server does not (leaked key)`);
    }
    console.log(`PASS: final client/server key sets match exactly (${finalClientKeys.size} agents)`);

    const refCountKeysFinal = getEncoderRefCountKeyCount(room);
    const distinctRefIds = new Set(agentRefIdsAssigned);
    const visitorSpawns = addAgentCallCount - GUIDE_ROBOT_COUNT;
    const routesWithMultipleOwners = [...routeEverOwners.values()].filter((owners) => owners.size > 1).length;

    console.log("\n=== RUN SUMMARY ===");
    console.log(`addAgent calls: ${addAgentCallCount} total (${GUIDE_ROBOT_COUNT} guide robots + ${visitorSpawns} visitor spawns)`);
    console.log(`removeAgent calls: ${removeAgentCallCount} (visitor despawns)`);
    console.log(`decorrelator add/remove cycles: ${decorrelatorCycles} (deliberate cross-key pool-order perturbation, see file header)`);
    console.log(`onAdd events observed by client: ${onAddEvents}, onRemove events: ${onRemoveEvents} (a gap here vs the addAgent/removeAgent totals above is EXPECTED, not a bug -- see file header's note on same-key collapse)`);
    console.log(
      `distinct Agent refIds assigned across all ${addAgentCallCount} addAgent calls: ${distinctRefIds.size} ` +
        `(sorted: [${[...distinctRefIds].sort((a, b) => a - b).join(",")}])`,
    );
    console.log(
      `encoder root.refCount key count: baseline=${refCountKeysBaseline} -> final=${refCountKeysFinal} ` +
        `(delta=${refCountKeysFinal - refCountKeysBaseline}, addAgent calls in that window=${addAgentCallCount - addAgentCallsAtBaseline})`,
    );
    console.log(
      `CLIENT-OBSERVED REUSE: ${routesWithMultipleOwners}/${routeEverOwners.size} distinct route objects were owned ` +
        `by more than one map key over the run. 0 here is EXPECTED and fine, not evidence recycling failed to ` +
        `happen -- the server-side refId numbers above already prove recycling quantitatively; this metric can ` +
        `only ever go positive when a cross-key reuse happens to land inside one unflushed patch (rare even with ` +
        `the decorrelator -- see file header), and when it stays at separate patches the decoder gives the new ` +
        `key a fresh local object regardless of server-side refId reuse, which is the safer of the two outcomes.`,
    );
    console.log(
      `position-coincidence (informational, NOT asserted): ${coincidentSampleHits} sample-hits away from the entrance, ` +
        `max coincident group size=${maxCoincidentGroupSize}`,
    );
    console.log(`route-not-cleared-on-add failures: ${routeNotClearedOnAddFailures.length}`);
    console.log(`aliasing/consistency failures: ${failures.length}`);

    // ---- regression floor: this run must have actually exercised the pool ----
    assert.ok(
      visitorSpawns >= MIN_VISITOR_SPAWNS,
      `only ${visitorSpawns} visitor spawns happened (need >= ${MIN_VISITOR_SPAWNS}) -- this run did not drive enough ` +
        "spawn/despawn churn to say anything about pool correctness; increase RUN_SECONDS",
    );
    console.log(`PASS: drove ${visitorSpawns} visitor spawn/despawn cycles through a ${SIMULATED_TARGET}-slot pool (>= ${MIN_VISITOR_SPAWNS} floor)`);

    // ---- prove refIds are genuinely being recycled (server-side, quantitative) ----
    assert.ok(
      distinctRefIds.size < visitorSpawns,
      `distinct refIds (${distinctRefIds.size}) should be far fewer than visitor spawns (${visitorSpawns}) if pooling ` +
        "is recycling instances -- this many distinct refIds for this few spawns means new instances are still " +
        "being minted per spawn, i.e. refIds are NOT being recycled",
    );
    const refCountGrowth = refCountKeysFinal - refCountKeysBaseline;
    assert.ok(
      refCountGrowth < visitorSpawns / 2,
      `encoder root.refCount grew by ${refCountGrowth} keys across ${visitorSpawns} post-baseline visitor spawns -- ` +
        "if pooling were recycling instances this should stay small and roughly flat regardless of spawn count " +
        "(this is the exact leak metric soaktest.ts's root-cause writeup used)",
    );
    console.log(
      `PASS: refIds are genuinely being recycled -- ${visitorSpawns} visitor spawns resolved to only ` +
        `${distinctRefIds.size} distinct refIds, and encoder root.refCount grew by only ${refCountGrowth} keys ` +
        "post-baseline (both far below the spawn count)",
    );

    // ---- the actual corruption checks ----
    assert.equal(
      routeNotClearedOnAddFailures.length,
      0,
      `route was non-empty immediately after addAgent ${routeNotClearedOnAddFailures.length} time(s):\n` +
        routeNotClearedOnAddFailures.join("\n"),
    );
    console.log(`PASS: every addAgent call (including reused pooled instances) left route.length === 0 at the call boundary`);

    assert.equal(
      failures.length,
      0,
      `${failures.length} aliasing/consistency failure(s) found:\n${failures.join("\n")}`,
    );
    console.log("PASS: no route-identity aliasing, id mismatch, or count divergence observed at any sample");

    await clientRoom.leave();
    console.log("\nALL PASS: pooltest.ts");
  } finally {
    if (decorrelatorTimer !== undefined) clearInterval(decorrelatorTimer);
    WorldRoom.prototype.addAgent = originalAddAgent;
    WorldRoom.prototype.removeAgent = originalRemoveAgent;
    await gameServer.gracefullyShutdown(false);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
