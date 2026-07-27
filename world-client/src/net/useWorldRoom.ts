import { useEffect, useRef, useState } from "react";
import { Client, getStateCallbacks } from "@colyseus/sdk";

/**
 * Task 3.3 extends this with `route` (the live, server-synced navigation polyline used by
 * scene/RouteLine.tsx), on top of the Task 3.2 architecture-proof client connection (still
 * not full reconnect handling). Joins the 'world' Colyseus room and keeps a mutable snapshot of
 * each synced agent's live fields in a ref (read every frame by scene components via
 * useFrame -- not React state, so 20Hz server patches don't force a React re-render per tick).
 * `agentIds` is plain React state and only changes when an agent is added/removed, which is
 * rare, so it's fine for that to trigger a render of the agent list.
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

const WORLD_SERVER_URL =
  (import.meta as { env?: { VITE_WORLD_SERVER_URL?: string } }).env?.VITE_WORLD_SERVER_URL ??
  "ws://localhost:2567";

export function useWorldRoom(): {
  agentIds: string[];
  agents: Map<string, AgentSnapshot>;
} {
  const agentsRef = useRef<Map<string, AgentSnapshot>>(new Map());
  const [agentIds, setAgentIds] = useState<string[]>([]);

  useEffect(() => {
    let disposed = false;
    let leave: (() => void) | null = null;

    const client = new Client(WORLD_SERVER_URL);
    client
      .joinOrCreate("world")
      .then((room) => {
        if (disposed) {
          room.leave();
          return;
        }
        leave = () => {
          room.leave();
        };

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
      })
      .catch((err: unknown) => {
        console.error("useWorldRoom: failed to join 'world' room", err);
      });

    return () => {
      disposed = true;
      leave?.();
    };
  }, []);

  return { agentIds, agents: agentsRef.current };
}
