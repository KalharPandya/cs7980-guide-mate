import { useEffect, useRef, useState } from "react";
import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";

import {
  computeReconnectDelayMs,
  shouldReconnect,
  statusForAttempt,
  type DisconnectReason,
} from "./reconnectPolicy";

/**
 * Task 3.3 extends this with `route` (the live, server-synced navigation polyline used by
 * scene/RouteLine.tsx), on top of the Task 3.2 architecture-proof client connection. Task 5.5
 * adds real reconnect handling (see reconnectPolicy.ts for the backoff math and the
 * intentional-vs-unexpected decision, kept as pure functions so they're actually testable).
 * Joins the 'world' Colyseus room and keeps a mutable snapshot of each synced agent's live
 * fields in a ref (read every frame by scene components via useFrame -- not React state, so a
 * 20Hz server patch doesn't force a React re-render per tick). `agentIds` is plain React state
 * and only changes when an agent is added/removed, which is rare, so it's fine for that to
 * trigger a render of the agent list. `status` is also plain React state, for the same reason
 * (it changes rarely, and driving a UI indicator IS its whole purpose -- see App.tsx).
 */
export interface AgentSnapshot {
  id: string;
  kind: string;
  x: number;
  z: number;
  heading: number;
  state: string;
  /**
   * Flattened (x0, z0, x1, z1, ...) polyline of this agent's current navigation route, or
   * empty when idle -- see world/src/rooms/schema/WorldState.ts's Agent.route doc comment
   * for why it's flattened numbers rather than an ArraySchema of a Point sub-schema.
   *
   * This is the LIVE Colyseus ArraySchema instance (captured once in `onAdd` below), not a
   * plain-array copy re-synced on every onChange like x/z/heading/state are: Colyseus
   * mutates one stable ArraySchema object in place via push()/clear() as patches arrive
   * (the same way `room.state.agents` itself is one stable MapSchema, never replaced), and
   * the callbacks API's "any property change" onChange is documented to fire for changes to
   * an instance's OWN directly-owned properties -- it is not guaranteed to also fire when a
   * property that is itself a nested collection is mutated internally. Rather than depend on
   * that undocumented behavior, RouteLine.tsx reads this reference fresh every frame in its
   * own useFrame poll (matching the same "poll, don't rely on a re-render" pattern
   * Robot.tsx/Visitor.tsx already use for x/z/heading/state).
   */
  route: ArrayLike<number>;
}

/**
 * A guide robot's home charging station -- see world/src/rooms/schema/WorldState.ts's Station
 * schema. Static for the room's lifetime (a robot's pad never moves), so unlike AgentSnapshot
 * these are held in plain React state, populated once as the server syncs them on join and
 * handed to scene/ChargingPads.tsx to draw the pads. No per-frame reactivity is needed.
 */
export interface StationSnapshot {
  id: string;
  x: number;
  z: number;
}

/**
 * Surfaced to the UI (see App.tsx's small status indicator) so a human glancing at an
 * unattended kiosk screen can tell the difference between "genuinely live" and "frozen on the
 * last frame it received before the connection dropped" -- the latter is the dangerous failure
 * mode here because agent positions are held in a mutable ref (see AgentSnapshot's doc comment
 * above), so the scene keeps looking alive with zero visual sign anything is wrong.
 *
 *  - 'connecting'   the very first join attempt is in flight, no room yet.
 *  - 'connected'    joined and receiving state.
 *  - 'reconnecting' the room was lost and a retry is scheduled/in flight (see reconnectPolicy.ts).
 *  - 'failed'       reconnecting has been failing long enough (FAILED_STATUS_ATTEMPT_THRESHOLD
 *                    attempts, ~15s at the default policy) that it likely needs a human's
 *                    attention -- retries keep happening in the background regardless, this is
 *                    purely a UI escalation, never a stop condition.
 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "failed";

const WORLD_SERVER_URL =
  (import.meta as { env?: { VITE_WORLD_SERVER_URL?: string } }).env?.VITE_WORLD_SERVER_URL ??
  "ws://localhost:2567";

export function useWorldRoom(): {
  agentIds: string[];
  agents: Map<string, AgentSnapshot>;
  stations: StationSnapshot[];
  status: ConnectionStatus;
} {
  const agentsRef = useRef<Map<string, AgentSnapshot>>(new Map());
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [stations, setStations] = useState<StationSnapshot[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    let disposed = false;
    let currentRoom: Room | null = null;
    // Set to true ONLY by the effect-cleanup path below, immediately before it calls
    // room.leave() itself -- this is what lets the room.onLeave handler tell "we did this on
    // purpose" apart from "the server/network did this to us" (see shouldReconnect's doc
    // comment in reconnectPolicy.ts for why that distinction is the whole point).
    let intentionalLeave = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // 1-based count of consecutive failed (re)connect attempts since the last successful join.
    // Reset to 0 on every successful join. Read by computeReconnectDelayMs/statusForAttempt.
    let attempt = 0;

    const clearAgents = () => {
      agentsRef.current.clear();
      setAgentIds([]);
      // Stations are re-published by the fresh room's onAdd right after this (same reason the
      // agents map is wiped on every (re)connect -- see the clearAgents() call site), so drop
      // the previous room's copy rather than leave stale pads on screen during a blip.
      setStations([]);
    };

    const scheduleRetry = () => {
      attempt += 1;
      setStatus(statusForAttempt(attempt));
      const delay = computeReconnectDelayMs(attempt);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;

      const client = new Client(WORLD_SERVER_URL);
      client
        .joinOrCreate("world")
        .then((room) => {
          if (disposed) {
            // The component unmounted while joinOrCreate() was still in flight -- this room
            // was never handed to any caller, so it just needs to be released. .catch() isn't
            // optional: an uncaught rejection here is at minimum console noise and, in a plain
            // Node script (hit for real while writing this task's manual E2E reconnect proof,
            // in the closely-related cleanup path below), an actually-fatal unhandled-rejection
            // crash. There's nothing useful to do with a failed leave() here regardless -- we're
            // already tearing down -- so swallow it.
            room.leave().catch(() => {});
            return;
          }
          currentRoom = room;
          intentionalLeave = false;
          attempt = 0;

          // @colyseus/sdk's Room has its OWN inner reconnection loop (up to 15 attempts,
          // ~100ms-5s backoff, entirely separate from reconnectPolicy.ts -- see
          // node_modules/@colyseus/sdk/build/Room.mjs's handleReconnection/retryReconnection)
          // that tries to resume the SAME session on a retryable close code, before onLeave
          // (below, which is what drives OUR retry) ever fires. Disabled here, deliberately:
          //  1. It's built to reconnect to the SAME still-running room/process -- exactly the
          //     case this hook does NOT need special handling for, since clearAgents() below
          //     already wipes and re-subscribes fresh on every (re)connect regardless (see its
          //     comment) -- there's no "seamless resume" benefit for us to lose.
          //  2. Verified live in this task's manual E2E reconnect proof: against a world-server
          //     that was actually killed and replaced with a new process (not a same-process
          //     network blip), the inner loop's first reconnect attempt hung indefinitely --
          //     no further log line, no onLeave, for 140+ seconds -- because it was trying to
          //     resume a room that no longer exists anywhere. That's precisely the "world-server
          //     restarts" scenario this whole feature exists to survive, and left uncontrolled
          //     it would silently defeat reconnectPolicy.ts's carefully-bounded backoff.
          // Disabling it makes onLeave fire immediately on ANY drop, so reconnectPolicy.ts's
          // tested, capped, UI-visible backoff is the ONLY retry behavior in play, not a
          // second opaque one layered underneath it.
          room.reconnection.enabled = false;

          // A brand-new room instance (whether this is the very first join or a reconnect
          // after a drop) means whatever the PREVIOUS room's agents map held is no longer
          // trustworthy: this new room's onAdd only fires for agents present in ITS state,
          // so an agent that was removed server-side while we were disconnected would never
          // get an onRemove call here and would linger forever as a ghost. Clearing on every
          // successful (re)connect, right before subscribing, is a correctness fix, not just
          // cosmetic -- it also means a brief blip doesn't blank the screen while it's still
          // retrying (see the module doc comment on ConnectionStatus), only once a NEW room
          // is actually live and about to repopulate it in the same tick.
          clearAgents();
          setStatus("connected");

          const $ = getStateCallbacks(room);
          $(room.state).agents.onAdd((agent, key) => {
            agentsRef.current.set(key, {
              id: agent.id,
              kind: agent.kind,
              x: agent.x,
              z: agent.z,
              heading: agent.heading,
              state: agent.state,
              route: agent.route,
            });
            setAgentIds(Array.from(agentsRef.current.keys()));

            $(agent).onChange(() => {
              const snapshot = agentsRef.current.get(key);
              if (snapshot) {
                snapshot.x = agent.x;
                snapshot.z = agent.z;
                snapshot.heading = agent.heading;
                snapshot.state = agent.state;
                // route is NOT reassigned here -- `agent.route` stays the same ArraySchema
                // instance for the agent's lifetime (see the AgentSnapshot.route doc comment
                // above); the snapshot's `route` reference from onAdd is still valid and
                // already reflects whatever push()/clear() calls the server has made.
              }
            });
          });

          $(room.state).agents.onRemove((_agent, key) => {
            agentsRef.current.delete(key);
            setAgentIds(Array.from(agentsRef.current.keys()));
          });

          // Charging stations are static (never move, never removed for the room's life), so
          // onAdd is all that's needed: it fires once per station present in the joined room's
          // initial state, appending each into plain React state for scene/ChargingPads.tsx.
          // No onChange/onRemove -- a Station's x/z are set once server-side and never mutated.
          $(room.state).stations.onAdd((station, key) => {
            setStations((prev) => [...prev, { id: key, x: station.x, z: station.z }]);
          });

          // Room-level protocol errors (e.g. the server calling `client.error(...)`). Purely
          // informational here -- a WebSocket close (handled by onLeave below, which drives
          // reconnection) normally follows shortly after, so this just logs context for
          // whichever close code shows up next rather than triggering its own retry.
          room.onError((code, message) => {
            console.error("useWorldRoom: room error", code, message);
          });

          room.onLeave((code, reason) => {
            currentRoom = null;
            const disconnectReason: DisconnectReason = intentionalLeave
              ? "intentional"
              : "unexpected";
            if (disposed) return;
            if (!shouldReconnect(disconnectReason)) return;
            console.warn(
              `useWorldRoom: room left unexpectedly (code=${code}, reason=${reason ?? ""}), reconnecting`,
            );
            scheduleRetry();
          });
        })
        .catch((err: unknown) => {
          if (disposed) return;
          console.error("useWorldRoom: failed to join 'world' room", err);
          scheduleRetry();
        });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (currentRoom) {
        intentionalLeave = true;
        // .catch() for the same reason as the disposed-while-joining branch above: if the
        // connection is already CLOSING/CLOSED right as unmount happens (a real race, not
        // hypothetical -- this exact call crashed the plain-Node E2E reconnect-proof script
        // with an uncaught "Sent before connected" DOMException the first time this was
        // tested, before this .catch() was added), room.leave()'s underlying send() throws
        // synchronously inside its Promise executor, which becomes a rejected promise with no
        // one to catch it otherwise.
        currentRoom.leave().catch(() => {});
        currentRoom = null;
      }
    };
  }, []);

  return { agentIds, agents: agentsRef.current, stations, status };
}
