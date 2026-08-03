import type { AgentSnapshot } from '../net/useWorldRoom'
import { Robots } from './Robot'
import { Visitors } from './Visitor'

/**
 * Task 3.2: replaces DemoAgents.tsx's placeholder colored boxes with real animated GLB models.
 * Takes the exact same live `agentIds`/`agents` props DemoAgents took (still produced by
 * useWorldRoom() in App.tsx, outside <Canvas> -- see App.tsx's comment for why) and dispatches
 * each agent to Robot.tsx or Visitor.tsx by `kind`. Robots are GPU-instanced (a fixed draw-call
 * count regardless of robot count, not literally one -- see Robot.tsx's doc comment for the
 * exact number); visitors are individually cloned so each can play its own Idle/Walk animation
 * -- see each file's doc comment for the reasoning.
 */
export function AgentInstances({
  agentIds,
  agents,
}: {
  agentIds: string[]
  agents: Map<string, AgentSnapshot>
}) {
  return (
    <>
      <Robots agentIds={agentIds} agents={agents} />
      <Visitors agentIds={agentIds} agents={agents} />
    </>
  )
}
