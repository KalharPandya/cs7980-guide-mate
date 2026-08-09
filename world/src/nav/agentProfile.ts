/**
 * Shared guide-robot / visitor-avatar footprint constants.
 *
 * buildNavMesh.ts uses these to erode the walkable navmesh (so a gap narrower than the
 * agent's footprint isn't marked walkable), and WorldRoom.ts uses the same values to size
 * the Detour Crowd agents it adds to that navmesh. They MUST stay equal: if the crowd
 * agent's radius/height disagreed with what the navmesh was eroded for, the crowd would
 * think agents fit through gaps the navmesh doesn't actually have room for (or vice
 * versa). Keeping a single exported source of truth makes that impossible to drift.
 */

/** Guide-robot / visitor-avatar footprint radius used to erode the walkable area.
 * This is the single source of truth for BOTH navmesh erosion and crowd agent size, so
 * the two stay in sync. We tried raising it toward 0.25 for more wall/agent clearance in
 * the small 5+5 scene, but test:nav (reachability + roomDoorSanity) fails at 0.21 and
 * above: the tight doorways to rooms 1430, Classroom 1426 and Classroom 1425 erode shut
 * (Detour returns DT_PARTIAL_RESULT, target polygon unreachable). 0.20 is the largest
 * value that keeps every room reachable, so this is the ceiling the floor plan allows. */
export const AGENT_RADIUS_M = 0.20;

/** Minimum clearance height for the agent to be considered able to stand/walk under. */
export const AGENT_HEIGHT_M = 1.8;
