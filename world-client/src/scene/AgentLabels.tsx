import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { Group, Vector3 } from 'three'

import type { AgentSnapshot } from '../net/useWorldRoom'
import { lerpXZToward } from './agentMotion'
import { displayNameForAgent } from './agentLabel'
import { ROBOT_HEIGHT_M } from './Robot'
import { VISITOR_HEIGHT_M } from './Visitor'
import {
  ESTIMATED_LABEL_HEIGHT_PX,
  estimateLabelWidthPx,
  selectVisibleLabels,
  type LabelCandidate,
} from './roomLabelLayout'

/**
 * Gap (meters) between the top of an agent's model and the bottom of its name tag. Small on
 * purpose: the tag has to read as belonging to the head under it, not as floating above the
 * room. Matched to RoomLabels.tsx's LABEL_CLEARANCE_ABOVE_CORE_M so the two annotation layers
 * sit off their subjects by the same amount.
 */
const TAG_CLEARANCE_ABOVE_HEAD_M = 0.25

/**
 * Height (meters above the floor) to pin an agent's tag at.
 *
 * Derived from the SAME constants the models are scaled to (Robot.tsx's ROBOT_HEIGHT_M = 0.5,
 * Visitor.tsx's VISITOR_HEIGHT_M = 1.7), never a third hardcoded number: the robot height has
 * already been changed once (1.4 -> 0.5 when the oversized body was overrunning the crowd
 * radius), and a private copy here would have silently left every robot tag floating a metre
 * above its robot after that change.
 *
 * Anything that is not explicitly a robot is treated as a person, matching
 * displayNameForAgent's rule and Visitor.tsx's own `kind === 'visitor'` filter being the
 * default population of this world.
 */
export function agentTagHeightM(kind: string): number {
  const modelHeight = kind === 'robot' ? ROBOT_HEIGHT_M : VISITOR_HEIGHT_M
  return modelHeight + TAG_CLEARANCE_ABOVE_HEAD_M
}

/**
 * How often the screen-space collision pass runs, in seconds. Same 10 Hz RoomLabels.tsx uses
 * and for the same reason: the tag ANCHOR tracks its agent at the full frame rate (see the
 * useFrame below), this interval only governs how often we re-decide WHICH tags may draw, and
 * a show/hide decision that lags by up to 100 ms is imperceptible while an O(n^2) pass over
 * ~60 agents every frame would not be free.
 */
const LAYOUT_INTERVAL_S = 0.1

/** Opacity fade, in ms. Matches RoomLabels.tsx so both annotation layers behave identically. */
const FADE_MS = 120

/** Scratch vector, module scope so the per-frame loop allocates nothing. */
const scratch = /* @__PURE__ */ new Vector3()

/**
 * Tag pill styling. Module scope (not rebuilt per render per agent) and split by kind so a
 * robot tag is distinguishable from a person's at a glance: a person gets the neutral dark
 * slate pill, a robot gets the teal one. Both are dark pills with white text rather than
 * RoomLabels.tsx's white-on-light pills, which serves two purposes at once -- it keeps them
 * legible against the light grey floor, and it keeps an agent tag from being mistaken for a
 * room label when the two land near each other.
 *
 * The wording carries the distinction too, so the tags do not depend on colour alone: a robot's
 * name is literally "Robot 5" (see agentLabel.ts's ROBOT_NAME_PREFIX).
 */
const TAG_BASE_STYLE: CSSProperties = {
  padding: '2px 7px',
  color: '#ffffff',
  fontSize: 11,
  lineHeight: '15px',
  fontWeight: 600,
  fontFamily: 'sans-serif',
  whiteSpace: 'nowrap',
  borderRadius: 999,
  boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
  pointerEvents: 'none',
  userSelect: 'none',
  // Starts hidden so a freshly spawned agent's tag cannot flash in an unculled pile before the
  // first layout pass runs (which is on the very next frame, see sinceLayout's initial value).
  opacity: 0,
  transition: `opacity ${FADE_MS}ms linear`,
}
const VISITOR_TAG_STYLE: CSSProperties = {
  ...TAG_BASE_STYLE,
  background: 'rgba(26, 34, 46, 0.86)',
  border: '1px solid rgba(255,255,255,0.28)',
}
const ROBOT_TAG_STYLE: CSSProperties = {
  ...TAG_BASE_STYLE,
  background: 'rgba(11, 110, 133, 0.88)',
  border: '1px solid rgba(180,240,255,0.45)',
}

/**
 * One tag's mutable per-frame state. OWNED BY THE TAG COMPONENT, created once when that tag
 * mounts and handed to the parent to borrow, rather than living in a map the parent rebuilds.
 *
 * That ownership direction is a bug fix, not a style choice. The first version of this kept a
 * `useMemo` map keyed off the agent list, which meant every agent add or remove threw the map
 * away and rebuilt it with null refs, relying on React re-invoking every tag's ref callback to
 * repopulate it. Simulated visitors spawn and despawn continuously (world/src/rooms/
 * simulatedVisitorSpawner.ts), so that rebuild happened constantly, and it was observed live in
 * the browser to leave the whole map holding nulls: no anchor meant no bid, no bid meant nothing
 * selected, and every tag on screen sat at opacity 0 permanently a minute after load. Anchoring
 * the state to the component that owns the DOM node and the three.js group means each ref is
 * attached exactly once at mount and detached once at unmount, and a churning agent list cannot
 * desynchronise it.
 */
interface TagRuntime {
  /** The anchor this tag's <Html> hangs off. Moved every frame to follow the agent. */
  group: Group | null
  /** The pill itself, whose opacity the layout pass drives. */
  node: HTMLDivElement | null
  /** Cached CSS-pixel size. Constant, because tags do not scale with camera distance. */
  width: number
  height: number
  /** False until width/height came from a real offsetWidth rather than the estimate. */
  measured: boolean
  /** Last opacity we wrote, so an unchanged decision costs no style write at all. */
  shown: boolean
}

/** Robots sort after people. See AgentLabels' doc comment on priority. */
function kindRank(kind: string): number {
  return kind === 'robot' ? 1 : 0
}

/**
 * A single agent's floating name tag: one <Html> pill hanging off a group that this component's
 * parent moves to the agent's live position every frame.
 *
 * `occlude` is deliberately NOT set, unlike RoomLabels.tsx. Two reasons, and they are specific
 * to agents rather than a general opinion about occlusion. First cost: drei's occlusion is a
 * raycast per label per frame, and where the room labels are 18 static anchors these are ~60
 * anchors that all move, so every ray would have to be re-cast against the wall/core/furniture
 * geometry every frame instead of settling. Second correctness: an agent tag CANNOT be lifted
 * clear of the building the way a room label is (its whole job is to sit on a head at 0.75m or
 * 1.95m, below the 2.7m walls), so with `occlude` on, a person walking behind any wall would
 * lose their tag for the whole time they are behind it, which is exactly when a viewer looking
 * at a top-down floor plan most wants to know who is over there. The accepted cost is that a
 * tag can show through a wall or a core with no visible agent under it.
 */
function AgentTag({
  id,
  name,
  kind,
  priority,
  snapshot,
  register,
}: {
  id: string
  name: string
  kind: string
  priority: number
  snapshot: AgentSnapshot
  register: (id: string, runtime: TagRuntime | null) => void
}) {
  // Created once for this tag's whole lifetime. The width starts as an estimate and is replaced
  // by a real offsetWidth on the first layout pass that finds the node laid out.
  const runtime = useMemo<TagRuntime>(
    () => ({
      group: null,
      node: null,
      width: estimateLabelWidthPx(name),
      height: ESTIMATED_LABEL_HEIGHT_PX,
      measured: false,
      shown: false,
    }),
    [name],
  )

  // Lend this tag's state to the parent's layout pass for exactly as long as the tag exists.
  // The cleanup is what keeps a despawned visitor from lingering in the parent's map as a ghost
  // anchor that still reserves screen space against the agents that are actually there.
  useEffect(() => {
    register(id, runtime)
    return () => register(id, null)
  }, [id, runtime, register])

  // Stable for this tag's lifetime (`runtime` never changes for a given mounted tag), so React
  // attaches each ref once at mount instead of detaching and reattaching on every parent render.
  // `void` is load-bearing, not decoration: an assignment expression evaluates to the assigned
  // value, and React 19 reads a ref callback's RETURN value as an optional cleanup function, so
  // returning the Group/element here would be handing React a non-function it has to complain
  // about. `void` forces the callback to return undefined.
  const setGroup = useCallback((group: Group | null) => void (runtime.group = group), [runtime])
  const setNode = useCallback((node: HTMLDivElement | null) => void (runtime.node = node), [runtime])

  // Seeded at the agent's CURRENT snapshot position, identical to the seed Robot.tsx's
  // <Instance position={...}> and Visitor.tsx's <primitive position={...}> use, which is what
  // makes the shared lerp below stay in lockstep with the model from the very first frame.
  return (
    <group ref={setGroup} position={[snapshot.x, agentTagHeightM(kind), snapshot.z]}>
      <Html center>
        <div
          ref={setNode}
          // Mirrors RoomLabels.tsx's `data-room-label`: these attributes are what make the tag
          // layer inspectable from the DOM, so "which tags drew and which were culled, and why"
          // can be counted in a live page instead of eyeballed off a screenshot.
          data-agent-tag={name}
          data-agent-kind={kind}
          data-agent-priority={priority}
          style={kind === 'robot' ? ROBOT_TAG_STYLE : VISITOR_TAG_STYLE}
        >
          {name}
        </div>
      </Html>
    </group>
  )
}

/**
 * Floating name tags above every agent's head: who each person on the floor is, and which robot
 * each robot is.
 *
 * ## Names
 *
 * Nothing in the synced state carries a human-readable name (see agentLabel.ts's doc comment for
 * the full accounting of what the server actually publishes and the exact id shapes it mints).
 * The name is therefore derived from the id, deterministically, on the client.
 *
 * ## Tracking a MOVING anchor
 *
 * This is the one thing room labels never had to do: a room's centre never moves, so
 * RoomLabels.tsx can hand <Html> a constant `position` prop and be done. An agent's rendered
 * position is not even its snapshot position -- Robot.tsx and Visitor.tsx EASE toward the synced
 * value (the server patches at ~20Hz, the client draws at 60fps, see agentMotion.ts), so a tag
 * pinned to `snapshot.x/z` would run ahead of the body under it by up to a patch interval and
 * visibly detach on every direction change.
 *
 * The fix is to run the agent's own easing on the tag anchor: this component calls the SAME
 * `lerpXZToward` helper, with the same target and the same frame delta, starting from the same
 * seed position. Same function, same inputs, same float ops, so the anchor and the model track
 * identically rather than approximately. That shared helper is load-bearing: changing the easing
 * in one place and not the other would separate every tag from its agent, which is precisely why
 * this does not reimplement the lerp inline.
 *
 * ## Cost
 *
 * ~50 robots plus ~10 visitors at 60fps, so per-frame React re-renders are out of the question.
 * This renders ONCE per change to the agent LIST (which is rare: an add or a remove) and after
 * that everything is refs -- one useFrame here walks every tag, moves its anchor, and writes
 * opacity directly on the DOM node, exactly the pattern RoomLabels.tsx established. The
 * component tree only churns when an agent actually joins or leaves.
 *
 * A one-frame note, stated rather than hidden: drei's <Html> subscribes its own useFrame from a
 * child component, and React runs child layout effects before parent ones, so <Html> reads the
 * anchor's matrix before this component has moved it. Each tag therefore renders at the anchor's
 * PREVIOUS frame position, i.e. ~16ms behind. At the ~1 m/s an agent walks that is ~1.6cm of lag
 * on a tag that already sits 25cm above a head, which is not observable. Fixing it properly
 * would mean a negative useFrame priority, and in R3F any non-zero priority takes over the
 * render loop and disables automatic rendering, which is a far worse trade for 16ms.
 *
 * ## Culling
 *
 * Reuses roomLabelLayout.ts's `selectVisibleLabels` outright rather than growing a second
 * placement rule: constant screen size plus first-fit greedy collision culling in fixed priority
 * order, dropping rather than nudging (see that module's doc comment for why each of those is
 * the way it is). Agents cluster far harder than rooms do -- 50 robots parked on their charging
 * pads, or a robot and the visitor it is escorting walking a metre apart -- so without this the
 * tags would be an unreadable stack exactly where the interesting thing is happening.
 *
 * Priority must not depend on the camera (that is what makes naive label culling flicker), so
 * it is: PEOPLE FIRST, then robots, each group sorted by id. People win because the tags exist
 * to say who the people are, and because a robot's identity is recoverable elsewhere (it has a
 * charging pad, a route line, and a number) while a person's is not. Sorting by id rather than
 * by join order makes the outcome stable across a reconnect too, since the agents map is rebuilt
 * from scratch on every (re)connect and would otherwise re-shuffle in arrival order.
 */
export function AgentLabels({
  agentIds,
  agents,
}: {
  agentIds: string[]
  agents: Map<string, AgentSnapshot>
}) {
  const { camera, size } = useThree()

  // Rebuilt only when the agent LIST changes (an add or a remove), not on every frame: `agents`
  // is a stable Map instance whose entries are mutated in place (see useWorldRoom.ts), so it
  // never changes identity and never re-triggers this on a position patch.
  const tags = useMemo(() => {
    const entries = agentIds
      .map((id) => ({ id, kind: agents.get(id)?.kind ?? 'visitor', name: agents.get(id)?.name ?? '' }))
      .sort(
        (a, b) =>
          kindRank(a.kind) - kindRank(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
    return entries.map((entry, index) => ({
      ...entry,
      priority: index,
      name: displayNameForAgent(entry.id, entry.kind, entry.name),
    }))
  }, [agentIds, agents])

  /**
   * Priority by agent id, read by the layout pass below. Kept as a lookup rather than stored on
   * the TagRuntime object because priority is a property of the whole CURRENT agent list (an
   * agent's rank shifts when another agent joins or leaves), while the runtime object belongs to
   * one tag and outlives those list changes.
   */
  const priorityById = useMemo(() => {
    const map = new Map<string, number>()
    for (const { id, priority } of tags) map.set(id, priority)
    return map
  }, [tags])

  /**
   * Every mounted tag's runtime, registered by the tag itself on mount (see AgentTag). Stable
   * for the component's whole life, never rebuilt from the agent list -- that rebuild is exactly
   * the bug documented on TagRuntime.
   */
  const runtime = useRef(new Map<string, TagRuntime>()).current
  const register = useCallback(
    (id: string, entry: TagRuntime | null) => {
      if (entry) runtime.set(id, entry)
      else runtime.delete(id)
    },
    [runtime],
  )

  // Starts at the full interval so the very first frame runs a layout pass rather than leaving
  // every tag hidden for 100 ms after an agent joins.
  const sinceLayout = useRef(LAYOUT_INTERVAL_S)
  const candidates = useRef<LabelCandidate[]>([])

  useFrame((_state, delta) => {
    // --- every frame: move each anchor with its agent (see the doc comment above) -------------
    for (const [id, entry] of runtime) {
      const snapshot = agents.get(id)
      if (!entry.group || !snapshot) continue
      lerpXZToward(entry.group, snapshot.x, snapshot.z, delta)
    }

    // --- at LAYOUT_INTERVAL_S: re-decide which tags may draw ----------------------------------
    sinceLayout.current += delta
    if (sinceLayout.current < LAYOUT_INTERVAL_S) return
    sinceLayout.current = 0

    camera.updateMatrixWorld()

    const bids = candidates.current
    bids.length = 0

    for (const [id, entry] of runtime) {
      if (!entry.group) continue
      // A tag whose agent has left the list but whose component has not unmounted yet must not
      // reserve screen space against the agents that are still here.
      const priority = priorityById.get(id)
      if (priority === undefined) continue

      // Measure once. The pill's size cannot change afterwards (constant screen size, no
      // webfont that could load late and reflow it), and offsetWidth forces a layout flush.
      if (!entry.measured && entry.node && entry.node.offsetWidth > 0) {
        entry.width = entry.node.offsetWidth
        entry.height = entry.node.offsetHeight
        entry.measured = true
      }

      // The anchor's world position, asked of the object itself rather than reconstructed from
      // the agent's floor-plan coordinates: App.tsx's <group scale={[1, 1, -1]}> north-up mirror
      // is above this component, and a second hand-written copy of that transform here is
      // exactly the kind of thing that drifts silently when the parent changes.
      entry.group.updateWorldMatrix(true, false)
      scratch.setFromMatrixPosition(entry.group.matrixWorld)
      scratch.project(camera)

      // NDC z outside [-1, 1] means the anchor is behind the camera or outside the frustum's
      // depth range; a point behind a perspective camera projects with negative w, mirroring x
      // and y through the origin, so it would otherwise claim a bogus rectangle on screen and
      // suppress a tag that really is visible.
      const inDepthRange = scratch.z >= -1 && scratch.z <= 1

      bids.push({
        key: id,
        priority,
        // Same mapping drei's defaultCalculatePosition uses, so the rectangle tested here is
        // the rectangle the browser actually draws.
        centerX: scratch.x * (size.width / 2) + size.width / 2,
        centerY: -(scratch.y * (size.height / 2)) + size.height / 2,
        width: entry.width,
        height: entry.height,
        eligible: inDepthRange,
      })
    }

    const visible = new Set(selectVisibleLabels(bids, size))
    for (const [id, entry] of runtime) {
      const shouldShow = visible.has(id)
      if (!entry.node || shouldShow === entry.shown) continue
      entry.node.style.opacity = shouldShow ? '1' : '0'
      entry.shown = shouldShow
    }
  })

  return (
    <>
      {tags.map(({ id, kind, name, priority }) => {
        const snapshot = agents.get(id)
        if (!snapshot) return null
        return (
          <AgentTag
            key={id}
            id={id}
            name={name}
            kind={kind}
            priority={priority}
            snapshot={snapshot}
            register={register}
          />
        )
      })}
    </>
  )
}
