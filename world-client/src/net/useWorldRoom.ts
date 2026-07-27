import { useEffect, useRef, useState } from "react";
import { Client, getStateCallbacks } from "@colyseus/sdk";

/**
 * Minimal architecture-proof client connection, not the full Task 3.3 (route line, bloom,
 * proper reconnect handling). Joins the 'world' Colyseus room and keeps a mutable snapshot of
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
          });
          setAgentIds(Array.from(agentsRef.current.keys()));

          $(agent).onChange(() => {
            const snapshot = agentsRef.current.get(key);
            if (snapshot) {
              snapshot.x = agent.x;
              snapshot.z = agent.z;
              snapshot.heading = agent.heading;
              snapshot.state = agent.state;
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
