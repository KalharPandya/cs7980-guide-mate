#!/usr/bin/env python3
"""
Widen every door-scale opening in floor-14.json's `walls[]` until an agent can actually walk
through it, by TRIMMING the jamb walls back along their own lines.

WHY THIS EXISTS
---------------
The wall lines came out of a raster trace of a line drawing, so the door openings are drawn at
the scale a human reads on paper, not at the scale the simulation walks through. The simulation
does not walk a point: `world/src/nav/agentProfile.ts` sets AGENT_RADIUS_M = 0.20, so a guide
robot / visitor avatar is 0.40 m across, and `world/src/nav/buildNavMesh.ts` erodes the walkable
surface by that radius on EVERY side of EVERY wall. A traced 0.63 m doorway therefore leaves
0.63 - 2 * 0.20 = 0.23 m of usable corridor, narrower than one agent, and Detour Crowd's
separation force makes two agents meeting in it worse still. That is why visitors pile up at
doors instead of going through them.

Fidelity to the source drawing is deliberately subordinate to passability here: this is a
simulation floor, not a construction document.

WHAT IT DOES
------------
1. Finds every OPENING: a gap an agent would have to squeeze through, of two kinds.
   - JAMB PAIR: two free wall ends facing each other across open space (collinear jambs like
     Classroom 1425's door, and L-corner jambs like the Gender Neutral Washroom's, are both this
     case). The clear width is the distance between the two tips.
   - END TO BODY: one free wall end stopping short of another wall's body (a room mouth like
     1407's). The clear width is the distance from the tip to that wall.
   Both kinds require the span across the gap to be genuinely open: no third wall lies within
   SPAN_CLEAR_M of it and nothing crosses it. That is what stops a run of three walls with two
   doors in it (the washroom block's east wall) from also being read as one big opening.
2. Widens each opening under TARGET_CLEAR_M by moving the jamb tips BACK ALONG THEIR OWN LINES,
   balanced about the opening, so no wall ever leaves its line or changes its bearing. Only
   `a`/`b` are touched: `height`, `glass` and any authored `note` ride along untouched.

WHAT IT WILL NOT DO
-------------------
- Trim a pinned wall (the envelope and the two core polygons are the floor's own outline).
- Trim a wall below MIN_JAMB_LENGTH_M, or past a point where another wall T-joins its body
  (that would strand the neighbour as a floating wall).
- Extend anything, ever. Every move only removes material, so an opening can only get wider and
  a `rooms[].door` anchor can only get FURTHER from the nearest wall. That is what makes this
  stage automatically compatible with rebuild_floor_plan.py's door guardrails
  (ROOM_DOOR_KEEP_CLEAR_M and the note-declares-a-door-gap rule both forbid ADDING material near
  a doorway); it cannot fight a guard whose direction it never travels in.

Where an opening cannot reach the target without destroying a jamb, it is widened as far as is
safe and reported as SHORT, never forced.

Deterministic and idempotent: trims are searched on a 1 mm grid (the file's own coordinate
resolution), an opening already at or above the target is skipped, and a trim that rounds to the
coordinate already on file is not applied. Re-running reproduces the same bytes.

This module is a STAGE of rebuild_floor_plan.py (it runs there, after every stage that reads the
source raster, so nothing downstream draws the widened doorway shut again). Run it directly for
the report only; it writes nothing of its own.

Usage:
    python widen_doorways.py            # print the before/after opening table, write nothing
"""

from __future__ import annotations

import math
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import clean_floor_plan as clean  # noqa: E402  (path set up above)

Point = Tuple[float, float]
Wall = Dict[str, Any]

# ---------------------------------------------------------------------------------------
# Tolerances
# ---------------------------------------------------------------------------------------

# The clear width every opening is widened to. world/src/nav/agentProfile.ts erodes the navmesh
# by AGENT_RADIUS_M = 0.20 on each side, so 1.20 m of drawn opening leaves 1.20 - 0.40 = 0.80 m
# of walkable width: two whole agent DIAMETERS, which is the width at which two agents can pass
# through in opposite directions without Detour Crowd's separation force pushing either of them
# into a wall. (At the old 0.63 m typical door that figure is 0.23 m, narrower than one agent.)
# It is also comfortably above CLOSE_PAIR_MAX_M = 1.00 m in rebuild_floor_plan.py, the widest gap
# that pipeline's "close a break the trace invented" stage will ever close, so a widened doorway
# is out of reach of the one stage that could otherwise draw it shut again.
TARGET_CLEAR_M = 1.20

# An opening at or above this is left alone; anything wider than SCAN_MAX_M is a room mouth or a
# corridor, not a door, and is only reported.
SCAN_MAX_M = 3.00

# A jamb may not be trimmed below this. rebuild_floor_plan.py's own PARTITION_MIN_LENGTH_M is
# 0.45 m: a partition shorter than that is not admitted by that pipeline at all, so trimming a
# jamb below it would DELETE the jamb on the next rebuild rather than shorten it. (That is not
# hypothetical: at a flat 0.45 the Event Space jamb came out 0.4498 m after its tip was rounded to
# the millimetre grid, and the next run dropped it and redrew the doorway.) The extra 5 mm is the
# rounding margin, an order of magnitude more than the half-millimetre a rounded coordinate can
# move. rebuild_floor_plan.py asserts the two agree, so this cannot drift.
MIN_JAMB_LENGTH_M = 0.455

# An endpoint sitting this close to another wall counts as attached to it.
ATTACH_EPS_M = 0.03

# The span across an opening must be clear of every other wall by this much. Half the rendered
# wall thickness: a wall closer than this is drawing the same line, so the "gap" is really two
# gaps with a wall between them.
SPAN_CLEAR_M = 0.10

# For an END TO BODY opening, trimming the end along its own axis has to actually widen the gap.
# cos(60 degrees): below this the wall runs too nearly PARALLEL to the wall it faces, and the
# distance between them is a corridor width that no amount of trimming changes. (This is what
# keeps the 1.04 m clearance between the south corridor's two long walls from being mistaken for
# a doorway.)
TRANSVERSE_COS = 0.5

# A trimmed tip may not come to rest this close to another wall's ENDPOINT.
# rebuild_floor_plan.py's regularizer welds every pair of partition endpoints within
# WELD_RADIUS_M = 0.20 m to their common centroid, so a tip parked just inside that radius does
# not stay where this pass put it: on the next run the weld drags it a centimetre or two, which
# on this plan was enough to pull a 0.455 m jamb under the 0.45 m admission floor and delete it
# (the washroom block's middle jamb, where the washroom's south wall T-joins it 0.33 m from the
# tip). 0.20 m plus 0.05 m of margin. Landing EXACTLY on the neighbouring endpoint would be
# stable too, but that is an extension of the junction rather than a trim of the doorway, so this
# pass simply stops short.
WELD_KEEP_M = 0.25

# Trims are searched on the file's own coordinate resolution, so the answer is exactly
# representable and the search is reproducible.
STEP_M = 0.001

# An opening within this of the target counts as satisfied. Absorbs the sub-millimetre residue
# left by rounding the trimmed tip to COORD_DECIMALS, which is what stops a re-run from chasing
# the last 0.3 mm forever.
SETTLE_EPS_M = 0.005


# ---------------------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------------------


def _dist(p: Point, q: Point) -> float:
    return math.hypot(p[0] - q[0], p[1] - q[1])


def _tips(wall: Wall) -> Tuple[Point, Point]:
    return clean.wall_points(wall)


def _trim_direction(wall: Wall, end: int) -> Point:
    """Unit vector from the given tip towards the wall's other end: the direction a trim moves
    that tip in. Trimming never leaves the wall's own line, so the bearing cannot change."""
    tip, far = (_tips(wall)[end], _tips(wall)[1 - end])
    length = _dist(tip, far)
    if length <= 0.0:
        return (0.0, 0.0)
    return ((far[0] - tip[0]) / length, (far[1] - tip[1]) / length)


def _tip_after(wall: Wall, end: int, trim: float) -> Point:
    tip = _tips(wall)[end]
    direction = _trim_direction(wall, end)
    return (tip[0] + direction[0] * trim, tip[1] + direction[1] * trim)


def _segment_distance(p1: Point, p2: Point, q1: Point, q2: Point) -> float:
    """Distance between two segments in 2D (0 if they intersect)."""
    if _segments_intersect(p1, p2, q1, q2):
        return 0.0
    seg_a = {"a": list(p1), "b": list(p2)}
    seg_b = {"a": list(q1), "b": list(q2)}
    return min(
        clean.segment_point_distance(q1, seg_a),
        clean.segment_point_distance(q2, seg_a),
        clean.segment_point_distance(p1, seg_b),
        clean.segment_point_distance(p2, seg_b),
    )


def _orient(p: Point, q: Point, r: Point) -> float:
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])


def _segments_intersect(p1: Point, p2: Point, q1: Point, q2: Point) -> bool:
    d1, d2 = _orient(q1, q2, p1), _orient(q1, q2, p2)
    d3, d4 = _orient(p1, p2, q1), _orient(p1, p2, q2)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def _endpoint_is_free(walls: Sequence[Wall], index: int, end: int) -> bool:
    point = _tips(walls[index])[end]
    return not any(
        clean.segment_point_distance(point, other) <= ATTACH_EPS_M
        for position, other in enumerate(walls)
        if position != index
    )


def _walls_touch(walls: Sequence[Wall], i: int, j: int) -> bool:
    """True when the two walls already meet, at a corner or as a T. Two walls that meet do not
    have a doorway between them; the short distance from one's tip to the other is the junction
    itself (the washroom block's east wall and the wall that T-joins it, 0.33 m apart)."""
    for point in _tips(walls[i]):
        if clean.segment_point_distance(point, walls[j]) <= ATTACH_EPS_M:
            return True
    for point in _tips(walls[j]):
        if clean.segment_point_distance(point, walls[i]) <= ATTACH_EPS_M:
            return True
    return False


def _span_is_open(walls: Sequence[Wall], start: Point, end: Point, exclude: Sequence[int]) -> bool:
    """The gap is only an opening if you could walk the straight line across it."""
    for index, wall in enumerate(walls):
        if index in exclude:
            continue
        a, b = _tips(wall)
        if _segment_distance(start, end, a, b) < SPAN_CLEAR_M:
            return False
    return True


def _junction_reach(walls: Sequence[Wall], index: int, end: int) -> float:
    """How far this tip may be trimmed before it passes a point where another wall lands on this
    wall's body. Trimming past such a junction would leave that neighbour floating."""
    wall = walls[index]
    tip = _tips(wall)[end]
    reach = clean.wall_length(wall)
    for position, other in enumerate(walls):
        if position == index:
            continue
        for point in _tips(other):
            if clean.segment_point_distance(point, wall) <= ATTACH_EPS_M:
                reach = min(reach, _dist(tip, point))
    return reach


def _trim_cap(walls: Sequence[Wall], index: int, end: int, pinned: int) -> float:
    """The most this tip may be pulled back."""
    if index < pinned:
        return 0.0
    length = clean.wall_length(walls[index])
    return max(0.0, min(length - MIN_JAMB_LENGTH_M, _junction_reach(walls, index, end)))


# ---------------------------------------------------------------------------------------
# Finding the openings
# ---------------------------------------------------------------------------------------


class Opening:
    """One gap an agent has to get through. `far` is the wall on the other side: a (wall, end)
    tip for a jamb pair, or a wall index alone for an end-to-body opening."""

    def __init__(
        self,
        width: float,
        near: Tuple[int, int],
        far_wall: int,
        far_end: Optional[int],
        where: Point,
    ) -> None:
        self.width = width
        self.near = near
        self.far_wall = far_wall
        self.far_end = far_end
        self.where = where

    @property
    def kind(self) -> str:
        return "jamb pair" if self.far_end is not None else "end to body"

    def label(self, rooms: Sequence[Dict[str, Any]]) -> str:
        room = min(rooms, key=lambda r: _dist(clean._pt(r["door"]), self.where))
        return f"{room['name']} ({_dist(clean._pt(room['door']), self.where):.2f} m away)"

    def gap(self, walls: Sequence[Wall], trim_near: float, trim_far: float) -> float:
        near = _tip_after(walls[self.near[0]], self.near[1], trim_near)
        if self.far_end is None:
            return clean.segment_point_distance(near, walls[self.far_wall])
        far = _tip_after(walls[self.far_wall], self.far_end, trim_far)
        return _dist(near, far)


def find_openings(walls: Sequence[Wall]) -> List[Opening]:
    """Every opening on the floor, narrowest first. Deterministic: ties break on wall index."""
    free = [
        (index, end)
        for index in range(len(walls))
        for end in (0, 1)
        if _endpoint_is_free(walls, index, end)
    ]

    pairs: List[Opening] = []
    for position, (i, ki) in enumerate(free):
        for (j, kj) in free[position + 1:]:
            if i == j or _walls_touch(walls, i, j):
                continue
            start, end = _tips(walls[i])[ki], _tips(walls[j])[kj]
            width = _dist(start, end)
            if not (ATTACH_EPS_M < width <= SCAN_MAX_M):
                continue
            if not _span_is_open(walls, start, end, exclude=(i, j)):
                continue
            pairs.append(Opening(width, (i, ki), j, kj, ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)))

    # A tip belongs to the nearest opening it is part of, and only to that one, so a wall end can
    # never be trimmed twice for two different doorways.
    claimed = set()
    result: List[Opening] = []
    for opening in sorted(pairs, key=lambda o: (round(o.width, 6), o.near, o.far_wall)):
        near, far = opening.near, (opening.far_wall, opening.far_end)
        if near in claimed or far in claimed:
            continue
        claimed.add(near)
        claimed.add(far)
        result.append(opening)

    for (i, ki) in free:
        if (i, ki) in claimed:
            continue
        start = _tips(walls[i])[ki]
        direction = _trim_direction(walls[i], ki)
        best: Optional[Opening] = None
        for j, other in enumerate(walls):
            if j == i or _walls_touch(walls, i, j):
                continue
            width = clean.segment_point_distance(start, other)
            if not (ATTACH_EPS_M < width <= SCAN_MAX_M):
                continue
            foot = _closest_point_on(start, other)
            if any(
                _dist(foot, tip) <= ATTACH_EPS_M and (j, far_end) in free
                for far_end, tip in enumerate(_tips(other))
            ):
                continue  # a free tip facing a free tip is a jamb pair, already rejected as one
            span = ((foot[0] - start[0]) / width, (foot[1] - start[1]) / width)
            if abs(direction[0] * span[0] + direction[1] * span[1]) < TRANSVERSE_COS:
                continue  # near parallel: this is a corridor width, not a doorway
            if not _span_is_open(walls, start, foot, exclude=(i, j)):
                continue
            if best is None or width < best.width:
                best = Opening(width, (i, ki), j, None, ((start[0] + foot[0]) / 2, (start[1] + foot[1]) / 2))
        if best is not None:
            claimed.add((i, ki))
            result.append(best)

    return sorted(result, key=lambda o: (round(o.width, 6), o.near, o.far_wall))


def _closest_point_on(point: Point, wall: Wall) -> Point:
    (ax, az), (bx, bz) = _tips(wall)
    dx, dz = bx - ax, bz - az
    length_sq = dx * dx + dz * dz
    if length_sq <= 0.0:
        return (ax, az)
    t = max(0.0, min(1.0, ((point[0] - ax) * dx + (point[1] - az) * dz) / length_sq))
    return (ax + t * dx, az + t * dz)


# ---------------------------------------------------------------------------------------
# Widening one opening
# ---------------------------------------------------------------------------------------


def _tip_settles(walls: Sequence[Wall], index: int, end: int, trim: float) -> bool:
    """Would a tip trimmed by this much STAY there? Not if it lands inside the weld radius of
    another wall's endpoint: see WELD_KEEP_M."""
    if trim <= 0.0:
        return True  # leaving a tip where it already is cannot be this pass's problem
    moved = _tip_after(walls[index], end, trim)
    for position, other in enumerate(walls):
        if position == index:
            continue
        if any(_dist(moved, tip) < WELD_KEEP_M for tip in _tips(other)):
            return False
    return True


def _allowed_trims(walls: Sequence[Wall], index: int, end: int, cap: float) -> List[float]:
    """Every trim of this tip, on the file's own millimetre grid, that is within the cap and comes
    to rest somewhere the regularizer will leave it. Always includes 0 (do nothing)."""
    steps = int(math.floor(round(cap / STEP_M, 6)))
    grid = [round(step * STEP_M, 6) for step in range(steps + 1)]
    if cap > 0 and (not grid or grid[-1] < cap):
        grid.append(cap)
    return [trim for trim in grid if _tip_settles(walls, index, end, trim)]


def _solve(
    opening: Opening,
    walls: Sequence[Wall],
    allowed_near: Sequence[float],
    allowed_far: Sequence[float],
) -> Tuple[float, float]:
    """The smallest balanced pair of trims that reaches the target, or the widest the two jambs
    allow if none does.

    Balanced means "trim both jambs equally", which for a collinear pair is exactly symmetric
    about the opening's centre; only once one jamb has run out does the other take the rest. The
    gap is searched rather than solved because for an L-corner opening it is not monotone in the
    trim (pulling one jamb back can close a few millimetres of lateral offset before it starts
    opening the gap), and a scan over the 1 mm coordinate grid is exact where a bisection is not.
    """
    both = sorted(set(allowed_near) & set(allowed_far))
    for trim in both:
        if opening.gap(walls, trim, trim) >= TARGET_CLEAR_M:
            return (trim, trim)
    base = both[-1] if both else 0.0
    for trim in allowed_near:
        if trim >= base and opening.gap(walls, trim, base) >= TARGET_CLEAR_M:
            return (trim, base)
    for trim in allowed_far:
        if trim >= base and opening.gap(walls, base, trim) >= TARGET_CLEAR_M:
            return (base, trim)
    return (max(allowed_near), max(allowed_far))


def _apply_trim(walls: List[Wall], index: int, end: int, trim: float) -> bool:
    if trim <= 0.0:
        return False
    key = "a" if end == 0 else "b"
    moved = _tip_after(walls[index], end, trim)
    rounded = [round(moved[0], clean.COORD_DECIMALS), round(moved[1], clean.COORD_DECIMALS)]
    if rounded == [round(v, clean.COORD_DECIMALS) for v in walls[index][key]]:
        return False
    wall = dict(walls[index])
    wall[key] = rounded
    walls[index] = wall
    return True


def widen_doorways(
    walls: Sequence[Wall], rooms: Sequence[Dict[str, Any]], pinned: int = 0
) -> Tuple[List[Wall], List[str], List[Dict[str, Any]]]:
    """Widen every opening under TARGET_CLEAR_M. Returns (walls, action lines, the table)."""
    result: List[Wall] = [dict(wall) for wall in walls]
    actions: List[str] = []
    table: List[Dict[str, Any]] = []

    for opening in find_openings(result):
        before = opening.gap(result, 0.0, 0.0)
        row = {
            "before": before,
            "kind": opening.kind,
            "near": opening.near,
            "far": (opening.far_wall, opening.far_end),
            "where": opening.where,
            "room": opening.label(rooms),
        }
        if before >= TARGET_CLEAR_M - SETTLE_EPS_M:
            row["after"] = before
            row["status"] = "ok"
            table.append(row)
            continue

        allowed_near = _allowed_trims(
            result, opening.near[0], opening.near[1],
            _trim_cap(result, opening.near[0], opening.near[1], pinned),
        )
        allowed_far = (
            _allowed_trims(
                result, opening.far_wall, opening.far_end,
                _trim_cap(result, opening.far_wall, opening.far_end, pinned),
            )
            if opening.far_end is not None
            else [0.0]
        )
        trim_near, trim_far = _solve(opening, result, allowed_near, allowed_far)
        _apply_trim(result, opening.near[0], opening.near[1], trim_near)
        if opening.far_end is not None:
            _apply_trim(result, opening.far_wall, opening.far_end, trim_far)

        after = opening.gap(result, 0.0, 0.0)
        row["after"] = after
        row["status"] = "widened" if after >= TARGET_CLEAR_M - SETTLE_EPS_M else "SHORT"
        table.append(row)
        if after - before > STEP_M:
            actions.append(
                f"widened the {before:.3f} m {opening.kind} opening near {row['room']} to "
                f"{after:.3f} m, trimming wall {opening.near[0]} back {trim_near:.3f} m"
                + (
                    f" and wall {opening.far_wall} back {trim_far:.3f} m"
                    if opening.far_end is not None
                    else " (the far side is a wall body, so only this jamb could move)"
                )
                + ("" if row["status"] != "SHORT" else
                   f"; SHORT of the {TARGET_CLEAR_M:.2f} m target because both jambs ran out of "
                   f"trim: the {MIN_JAMB_LENGTH_M:.3f} m length floor, a T-junction on their body, "
                   f"or the {WELD_KEEP_M:.2f} m they must stay clear of a neighbouring endpoint")
            )

    return clean.round_walls(result), actions, table


# ---------------------------------------------------------------------------------------
# Report-only entry point
# ---------------------------------------------------------------------------------------


def _pinned_count(plan: Dict[str, Any]) -> int:
    """rebuild_floor_plan.py writes the envelope (one wall per walkableOutline edge) first, then
    the core (one per hole-polygon edge), then the partitions. Verified against the geometry
    rather than assumed, so this fails loudly on a file that is not rebuild output."""
    edges: List[Tuple[Point, Point]] = []
    for polygon in [plan["walkableOutline"]] + [hole["polygon"] for hole in plan["holes"]]:
        points = [clean._pt(p) for p in polygon]
        edges.extend(zip(points, points[1:] + points[:1]))
    for index, (start, end) in enumerate(edges):
        a, b = _tips(plan["walls"][index])
        assert _dist(a, start) < 1e-6 and _dist(b, end) < 1e-6, (
            f"wall {index} is not the envelope/core edge it should be: this file is not "
            f"rebuild_floor_plan.py output"
        )
    return len(edges)


def main() -> int:
    plan, _ = clean.read_plan(clean.SERVER_PLAN_PATH)
    walls = clean.round_walls(plan["walls"])
    pinned = _pinned_count(plan)
    _, actions, table = widen_doorways(walls, plan["rooms"], pinned=pinned)

    print(f"target clear width  : {TARGET_CLEAR_M:.2f} m  (agent diameter 0.40 m, so "
          f"{TARGET_CLEAR_M - 0.40:.2f} m walkable after navmesh erosion)")
    print(f"jamb length floor   : {MIN_JAMB_LENGTH_M:.3f} m  (weld keep-clear {WELD_KEEP_M:.2f} m)")
    print(f"pinned walls        : {pinned} (envelope + core, never trimmed)")
    print()
    print(f"{'before':>8} {'after':>8}  {'status':<8} {'kind':<12} {'jambs':<18} where")
    for row in table:
        near = f"w{row['near'][0]}.{row['near'][1]}"
        far = f"w{row['far'][0]}" + (f".{row['far'][1]}" if row["far"][1] is not None else " body")
        print(
            f"{row['before']:8.3f} {row['after']:8.3f}  {row['status']:<8} {row['kind']:<12} "
            f"{near + ' <-> ' + far:<18} {row['room']}"
        )
    print()
    for line in actions:
        print(f"  - {line}")
    print("\n(report only: nothing written. rebuild_floor_plan.py is what applies this.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
