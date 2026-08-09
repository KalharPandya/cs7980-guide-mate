#!/usr/bin/env python3
"""
Deterministic geometry cleanup for the floor-14 wall network.

WHY THIS EXISTS
---------------
floor-14.json's `walls[]` was produced by a Hough-line trace of a raster floor-plan drawing
(see the file's own "source"/"note" fields). A line tracer emits one segment per detected ink
run, so a single physical wall drawn as a 2-pixel-thick line commonly comes back as TWO nearly
identical segments a few millimetres apart, plus short shards where the line was broken by a
door swing, a label, or antialiasing. Extruded into 3D by world-client's Walls.tsx that reads
as a "wall diagram": doubled boxes, floating stubs, corners that visibly do not meet.

This script rewrites ONLY the `walls[]` array so the same building reads as a building. It is
allowed to change wall dimensions and angles for the sake of looking clean; it is NOT allowed
to close a doorway (see the guardrails below), because world/src/nav/buildNavMesh.ts extrudes
every wall into a real Recast obstacle, so a wall edit is a NAVIGATION change, not a cosmetic
one.

PIPELINE (see clean_walls())
    A  DROP DEGENERATE      drop segments shorter than MIN_WALL_LENGTH_M
    B  DEDUPE STACKED       merge near-identical doubled segments (to a fixpoint)
    C  MERGE COLLINEAR      join near-collinear runs across a small gap (to a fixpoint)
    D  WELD ENDPOINTS       single-linkage cluster nearby endpoints, snap to centroid
    A  DROP DEGENERATE      again, in case a weld collapsed something
    E  DROP ORPHAN SHARDS   drop short segments that touch nothing
    F  SNAP T-JUNCTIONS     land free ends on the BODY of the wall they meet (to a fixpoint)
    D  WELD ENDPOINTS       again, so points a snap made coincident count as shared
    A  DROP DEGENERATE      again
The whole pipeline is then repeated until it stops changing the wall list, which is what makes
the script idempotent: the file it writes is a fixpoint, so a second run rewrites it byte for
byte identically.

USAGE
    python world/data/tools/clean_floor_plan.py --report
    python world/data/tools/clean_floor_plan.py --dry-run --report
Writes BOTH copies of the plan (world/data and world-client/public/data), which a test asserts
are byte-identical. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------------------
# Tolerances. Every number the pipeline keys off lives here so it can be tuned in one place.
# ---------------------------------------------------------------------------------------

# --- Stage A: degenerate segments -------------------------------------------------------
# Anything shorter than this is trace noise, not a wall. Also the floor under which a weld is
# not allowed to shorten an existing wall (see WELD guard).
MIN_WALL_LENGTH_M = 0.15

# --- Stage B: stacked / doubled segments ------------------------------------------------
# Two segments are "the same physical wall traced twice" when they are near-parallel, the
# shorter one hugs the longer one's infinite line, and they overlap along it.
STACK_ANGLE_DEG = 8.0          # max angle between the two segments
STACK_PERP_M = 0.30            # max perpendicular distance, shorter's endpoints to longer's line
STACK_OVERLAP_FRACTION = 0.50  # projected overlap must exceed this fraction of the shorter one

# --- Stage C: collinear chains ----------------------------------------------------------
# Two segments are "one wall broken into pieces" when they are near-collinear and the break
# between them is too narrow to walk through anyway (see AGENT_DIAMETER_M).
CHAIN_ANGLE_DEG = 6.0          # max angle between the two segments
CHAIN_PERP_M = 0.12            # max distance of any of the 4 endpoints from the joint best-fit line
CHAIN_MAX_GAP_M = 0.35         # max axial gap that may be bridged

# --- Stage D: endpoint welding ----------------------------------------------------------
WELD_RADIUS_M = 0.15           # single-linkage cluster radius for endpoints

# --- Stage F: T-junction snapping -------------------------------------------------------
# Stage D only welds endpoint TO endpoint, so it never catches the commonest defect in a
# raster trace: a partition whose end stops a few millimetres SHORT of (or a few past) the
# wall it meets. At 0.15 m wall thickness those render as hairline cracks and floating wall
# ends, which is what still made the floor read as a diagram after A-E. Stage F takes every
# free endpoint and lands it on the exact perpendicular foot of the nearest wall BODY.
T_SNAP_MAX_M = 0.30            # max distance from a free endpoint to a wall body to snap it
T_SNAP_MIN_T = 0.02            # foot must be at least this far along the target (not its tip:
T_SNAP_MAX_T = 0.98            # a tip meeting is stage D's job, and moving onto one fights it)
# A T-junction is by definition a TRANSVERSE meeting. Two near-parallel walls that happen to
# sit within T_SNAP_MAX_M of each other are a bundle the earlier stages declined to merge, not
# a junction, and snapping between them just drags them together. Enforcing a minimum crossing
# angle is also what makes stage F terminate: without it, a bundle of near-parallel walls each
# lands on the next one's body, moving it, and the cluster creeps by millimetres forever
# (observed on walls 38/59/76/91, which never converged).
T_SNAP_MIN_ANGLE_DEG = 20.0
# A snap smaller than this is treated as already landed and skipped. Without it, rounding to
# COORD_DECIMALS leaves a sub-millimetre residue that the next pass would "fix" forever, so
# this is what makes stage F terminate and the whole script idempotent.
T_SNAP_EPS_M = 0.0005

# --- Stage E: orphan shards -------------------------------------------------------------
ORPHAN_MAX_LENGTH_M = 0.90     # a segment shorter than this...
# ...is dropped if (post-weld) neither of its endpoints coincides with any other wall's
# endpoint. Walls carrying a `note` are exempt: a note marks a deliberate authored decision
# (e.g. the wall trimmed back to leave the Gender Neutral Washroom door gap), not trace noise.

# --- HARD GUARDRAILS --------------------------------------------------------------------
# Recast erodes the navmesh by the agent's radius (world/src/nav/agentProfile.ts,
# AGENT_RADIUS_M = 0.20), so a gap narrower than the agent's DIAMETER is already impassable
# and bridging it changes nothing. CHAIN_MAX_GAP_M is deliberately below this.
AGENT_DIAMETER_M = 0.40
# Never merge across a gap this wide or wider: real door openings start around 0.7 m and
# losing one makes a room unreachable. Asserted against CHAIN_MAX_GAP_M at import time.
DOOR_MIN_GAP_M = 0.60
# A gap at least this wide between endpoints of two DIFFERENT walls is treated as a possible
# doorway and protected during welding.
DOOR_PROTECT_MIN_GAP_M = 0.45
# ...and only up to this, past which two endpoints are simply unrelated, not a doorway.
DOOR_PROTECT_MAX_GAP_M = 2.50
# A weld may not narrow a protected gap by more than this. Violating clusters are frozen
# (their members keep their original coordinates) and the weld is recomputed.
DOOR_MAX_GAP_SHRINK_M = 0.10
# An opening at or below this is door-scale, so the relative DOOR_MAX_GAP_SHRINK_M rule guards
# it as well as the absolute DOOR_MIN_GAP_M floor. Above it the opening is a room mouth or a
# corridor and only the absolute floor applies: relative-guarding those blocked stage-F snaps
# that merely trimmed a 2.22 m opening to 2.07 m, which closes nothing and left real cracks.
DOOR_TIGHT_GAP_M = 1.00

# --- Fit / output -----------------------------------------------------------------------
# Weight each endpoint by its own segment's length when fitting the merged line. Unweighted,
# a 1.3 m twin would tilt the 8.6 m wall it shadows as much as the wall tilts itself; weighted,
# the long wall dominates and the short one is absorbed into it. Set False for a plain
# unweighted total-least-squares fit through the 4 endpoints.
FIT_WEIGHT_BY_LENGTH = True
# Coordinates are rounded to this many decimals (1 mm) on every pass, matching the precision
# already in the file. Rounding inside the fixpoint loop is what makes the written file a true
# fixpoint of the pipeline rather than one that drifts in the last decimal on re-runs.
COORD_DECIMALS = 3
# Guard against a non-converging pipeline instead of looping forever.
MAX_OUTER_PASSES = 20

# Marker for the sentence appended to the plan's top-level "note". Used to strip a previous
# run's sentence before appending the current one, so re-running does not stack sentences.
NOTE_MARKER = "Geometry cleanup pass (world/data/tools/clean_floor_plan.py):"

assert CHAIN_MAX_GAP_M < DOOR_MIN_GAP_M, "stage C would be allowed to bridge a doorway"
assert CHAIN_MAX_GAP_M < AGENT_DIAMETER_M, "stage C would be allowed to bridge a walkable gap"

# ---------------------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------------------

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", "..", ".."))
SERVER_PLAN_PATH = os.path.join(_REPO_ROOT, "world", "data", "floor-14.json")
CLIENT_PLAN_PATH = os.path.join(_REPO_ROOT, "world-client", "public", "data", "floor-14.json")

Point = Tuple[float, float]
Wall = Dict[str, Any]

# ---------------------------------------------------------------------------------------
# Small geometry helpers
# ---------------------------------------------------------------------------------------


def _pt(value: Sequence[float]) -> Point:
    return (float(value[0]), float(value[1]))


def wall_points(wall: Wall) -> Tuple[Point, Point]:
    return _pt(wall["a"]), _pt(wall["b"])


def wall_length(wall: Wall) -> float:
    (ax, az), (bx, bz) = wall_points(wall)
    return math.hypot(bx - ax, bz - az)


def wall_angle_deg(wall: Wall) -> float:
    """Undirected orientation in [0, 180)."""
    (ax, az), (bx, bz) = wall_points(wall)
    return math.degrees(math.atan2(bz - az, bx - ax)) % 180.0


def angle_diff_deg(angle_a: float, angle_b: float) -> float:
    """Smallest angle between two undirected orientations, in [0, 90]."""
    diff = abs(angle_a - angle_b) % 180.0
    return min(diff, 180.0 - diff)


def unit_direction(wall: Wall) -> Point:
    (ax, az), (bx, bz) = wall_points(wall)
    length = math.hypot(bx - ax, bz - az)
    if length == 0.0:
        return (1.0, 0.0)
    return ((bx - ax) / length, (bz - az) / length)


def project(point: Point, origin: Point, direction: Point) -> float:
    return (point[0] - origin[0]) * direction[0] + (point[1] - origin[1]) * direction[1]


def perpendicular_distance(point: Point, origin: Point, direction: Point) -> float:
    return abs((point[0] - origin[0]) * direction[1] - (point[1] - origin[1]) * direction[0])


def _canonical_direction(dx: float, dz: float) -> Point:
    """Fix the sign of a fitted axis so the fit is reproducible run to run."""
    if dx < 0.0 or (dx == 0.0 and dz < 0.0):
        return (-dx, -dz)
    return (dx, dz)


def fit_line(points: Sequence[Point], weights: Sequence[float]) -> Tuple[Point, Point]:
    """
    Total-least-squares (PCA) best-fit line through weighted points.

    Returns (centroid, unit direction of the major axis). The direction of the principal axis
    of the 2x2 weighted scatter matrix [[sxx, sxz], [sxz, szz]] is theta = 0.5*atan2(2*sxz,
    sxx - szz); atan2 keeps this branch-free and deterministic.
    """
    total_weight = sum(weights)
    if total_weight <= 0.0:
        weights = [1.0] * len(points)
        total_weight = float(len(points))

    cx = sum(w * p[0] for w, p in zip(weights, points)) / total_weight
    cz = sum(w * p[1] for w, p in zip(weights, points)) / total_weight

    sxx = sum(w * (p[0] - cx) ** 2 for w, p in zip(weights, points))
    szz = sum(w * (p[1] - cz) ** 2 for w, p in zip(weights, points))
    sxz = sum(w * (p[0] - cx) * (p[1] - cz) for w, p in zip(weights, points))

    theta = 0.5 * math.atan2(2.0 * sxz, sxx - szz)
    return (cx, cz), _canonical_direction(math.cos(theta), math.sin(theta))


def _fit_inputs(wall_a: Wall, wall_b: Wall) -> Tuple[List[Point], List[float]]:
    a0, a1 = wall_points(wall_a)
    b0, b1 = wall_points(wall_b)
    points = [a0, a1, b0, b1]
    if FIT_WEIGHT_BY_LENGTH:
        len_a = max(wall_length(wall_a), 1e-9)
        len_b = max(wall_length(wall_b), 1e-9)
        weights = [len_a, len_a, len_b, len_b]
    else:
        weights = [1.0, 1.0, 1.0, 1.0]
    return points, weights


def merge_notes(wall_a: Wall, wall_b: Wall) -> Optional[str]:
    """Carry every input `note` forward onto the merged descendant, in order, deduplicated."""
    notes: List[str] = []
    for wall in (wall_a, wall_b):
        note = wall.get("note")
        if isinstance(note, str) and note and note not in notes:
            notes.append(note)
    if not notes:
        return None
    return "\n\n".join(notes)


def merge_walls(wall_a: Wall, wall_b: Wall) -> Wall:
    """
    Fuse two segments into one: best-fit line through their endpoints, extent = the union of
    their projections onto it. `glass` is sticky (an authored design decision, never lost),
    `height` comes from the longer input, notes are concatenated.
    """
    points, weights = _fit_inputs(wall_a, wall_b)
    origin, direction = fit_line(points, weights)

    ts = [project(p, origin, direction) for p in points]
    t_min, t_max = min(ts), max(ts)

    start = (origin[0] + t_min * direction[0], origin[1] + t_min * direction[1])
    end = (origin[0] + t_max * direction[0], origin[1] + t_max * direction[1])

    longer = wall_a if wall_length(wall_a) >= wall_length(wall_b) else wall_b
    # Keep the merged segment pointing the same way the dominant input did, so re-running the
    # pipeline on its own output does not flip a/b back and forth.
    (lax, laz), (lbx, lbz) = wall_points(longer)
    if (lbx - lax) * direction[0] + (lbz - laz) * direction[1] < 0.0:
        start, end = end, start

    merged: Wall = {
        "a": [start[0], start[1]],
        "b": [end[0], end[1]],
        "height": longer["height"],
        "glass": bool(wall_a.get("glass")) or bool(wall_b.get("glass")),
    }
    note = merge_notes(wall_a, wall_b)
    if note is not None:
        merged["note"] = note
    return merged


def round_wall(wall: Wall) -> Wall:
    rounded: Wall = {
        "a": [round(float(wall["a"][0]), COORD_DECIMALS), round(float(wall["a"][1]), COORD_DECIMALS)],
        "b": [round(float(wall["b"][0]), COORD_DECIMALS), round(float(wall["b"][1]), COORD_DECIMALS)],
        "height": wall["height"],
        "glass": bool(wall["glass"]),
    }
    if wall.get("note") is not None:
        rounded["note"] = wall["note"]
    return rounded


def round_walls(walls: Iterable[Wall]) -> List[Wall]:
    return [round_wall(w) for w in walls]


# ---------------------------------------------------------------------------------------
# Stage A: drop degenerate segments
# ---------------------------------------------------------------------------------------


def drop_degenerate(walls: List[Wall]) -> List[Wall]:
    return [w for w in walls if wall_length(w) >= MIN_WALL_LENGTH_M]


# ---------------------------------------------------------------------------------------
# Stage B: dedupe stacked (doubled) pairs
# ---------------------------------------------------------------------------------------


def is_stacked_pair(wall_a: Wall, wall_b: Wall) -> bool:
    if angle_diff_deg(wall_angle_deg(wall_a), wall_angle_deg(wall_b)) > STACK_ANGLE_DEG:
        return False

    longer, shorter = (wall_a, wall_b) if wall_length(wall_a) >= wall_length(wall_b) else (wall_b, wall_a)
    shorter_length = wall_length(shorter)
    if shorter_length <= 0.0:
        return False

    origin = _pt(longer["a"])
    direction = unit_direction(longer)

    s0, s1 = wall_points(shorter)
    if perpendicular_distance(s0, origin, direction) > STACK_PERP_M:
        return False
    if perpendicular_distance(s1, origin, direction) > STACK_PERP_M:
        return False

    l0, l1 = wall_points(longer)
    long_lo, long_hi = sorted((project(l0, origin, direction), project(l1, origin, direction)))
    short_lo, short_hi = sorted((project(s0, origin, direction), project(s1, origin, direction)))

    overlap = min(long_hi, short_hi) - max(long_lo, short_lo)
    return overlap > STACK_OVERLAP_FRACTION * shorter_length


def dedupe_stacked(walls: List[Wall]) -> List[Wall]:
    """Merge stacked pairs, restarting the scan after each merge, until none remain."""
    result = list(walls)
    changed = True
    while changed:
        changed = False
        for i in range(len(result)):
            for j in range(i + 1, len(result)):
                if is_stacked_pair(result[i], result[j]):
                    merged = merge_walls(result[i], result[j])
                    result = result[:i] + [merged] + result[i + 1 : j] + result[j + 1 :]
                    changed = True
                    break
            if changed:
                break
    return result


# ---------------------------------------------------------------------------------------
# Stage C: merge collinear chains
# ---------------------------------------------------------------------------------------


def collinear_chain_gap(wall_a: Wall, wall_b: Wall) -> Optional[float]:
    """
    Axial gap between two near-collinear segments, or None if they are not chainable.
    Returns 0.0 when their projections already overlap.
    """
    if angle_diff_deg(wall_angle_deg(wall_a), wall_angle_deg(wall_b)) > CHAIN_ANGLE_DEG:
        return None

    points, weights = _fit_inputs(wall_a, wall_b)
    origin, direction = fit_line(points, weights)

    if max(perpendicular_distance(p, origin, direction) for p in points) > CHAIN_PERP_M:
        return None

    ts = [project(p, origin, direction) for p in points]
    a_lo, a_hi = sorted(ts[0:2])
    b_lo, b_hi = sorted(ts[2:4])

    gap = max(0.0, max(a_lo, b_lo) - min(a_hi, b_hi))
    if gap > CHAIN_MAX_GAP_M:
        return None
    # Belt and braces against the "never close a doorway" guardrail: CHAIN_MAX_GAP_M is
    # already below DOOR_MIN_GAP_M, this catches a bad retune of the constants.
    if gap >= DOOR_MIN_GAP_M:
        return None
    return gap


def merge_collinear_chains(walls: List[Wall]) -> List[Wall]:
    """Join collinear runs, restarting the scan after each merge, until none remain."""
    result = list(walls)
    changed = True
    while changed:
        changed = False
        for i in range(len(result)):
            for j in range(i + 1, len(result)):
                if collinear_chain_gap(result[i], result[j]) is not None:
                    merged = merge_walls(result[i], result[j])
                    result = result[:i] + [merged] + result[i + 1 : j] + result[j + 1 :]
                    changed = True
                    break
            if changed:
                break
    return result


# ---------------------------------------------------------------------------------------
# Stage D: weld endpoints
# ---------------------------------------------------------------------------------------


class _UnionFind:
    def __init__(self, size: int) -> None:
        self._parent = list(range(size))

    def find(self, index: int) -> int:
        while self._parent[index] != index:
            self._parent[index] = self._parent[self._parent[index]]
            index = self._parent[index]
        return index

    def union(self, left: int, right: int) -> None:
        root_left, root_right = self.find(left), self.find(right)
        if root_left != root_right:
            # Always keep the lower root so cluster identity is index-deterministic.
            if root_left < root_right:
                self._parent[root_right] = root_left
            else:
                self._parent[root_left] = root_right


def _endpoint_list(walls: Sequence[Wall]) -> List[Point]:
    """Flattened endpoints: wall i contributes indices 2i (a) and 2i+1 (b)."""
    points: List[Point] = []
    for wall in walls:
        a, b = wall_points(wall)
        points.append(a)
        points.append(b)
    return points


def _protected_gaps(points: Sequence[Point]) -> List[Tuple[int, int, float]]:
    """
    Endpoint pairs from DIFFERENT walls that are far enough apart to be a real opening a
    person could walk through, and close enough to be one wall's door rather than two
    unrelated parts of the building. These are the gaps welding must not narrow.
    """
    protected: List[Tuple[int, int, float]] = []
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if i // 2 == j // 2:
                continue  # same wall's own two ends
            dist = math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1])
            if DOOR_PROTECT_MIN_GAP_M <= dist <= DOOR_PROTECT_MAX_GAP_M:
                protected.append((i, j, dist))
    return protected


def _weld_once(walls: List[Wall]) -> List[Wall]:
    """
    One welding pass: single-linkage cluster endpoints within WELD_RADIUS_M and snap each
    cluster to its centroid, then freeze any cluster whose move would either narrow a
    protected door gap by more than DOOR_MAX_GAP_SHRINK_M or collapse a real wall below
    MIN_WALL_LENGTH_M, and recompute. Repeats until no violation remains (freezing is
    monotone, so this terminates).
    """
    points = _endpoint_list(walls)
    protected = _protected_gaps(points)
    original_lengths = [wall_length(w) for w in walls]

    union_find = _UnionFind(len(points))
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) <= WELD_RADIUS_M:
                union_find.union(i, j)

    clusters: Dict[int, List[int]] = {}
    for index in range(len(points)):
        clusters.setdefault(union_find.find(index), []).append(index)

    frozen: set = set()
    for _ in range(len(clusters) + 1):
        snapped: List[Point] = list(points)
        for root, members in clusters.items():
            if root in frozen:
                continue
            cx = sum(points[m][0] for m in members) / len(members)
            cz = sum(points[m][1] for m in members) / len(members)
            for m in members:
                snapped[m] = (cx, cz)

        violating_roots: List[int] = []
        for i, j, original in protected:
            new_dist = math.hypot(snapped[i][0] - snapped[j][0], snapped[i][1] - snapped[j][1])
            if new_dist < original - DOOR_MAX_GAP_SHRINK_M:
                violating_roots.extend([union_find.find(i), union_find.find(j)])
        for w_index, original_length in enumerate(original_lengths):
            if original_length < MIN_WALL_LENGTH_M:
                continue
            a, b = snapped[2 * w_index], snapped[2 * w_index + 1]
            if math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_WALL_LENGTH_M:
                violating_roots.extend([union_find.find(2 * w_index), union_find.find(2 * w_index + 1)])

        new_frozen = {root for root in violating_roots if root not in frozen}
        if not new_frozen:
            break
        frozen |= new_frozen

    welded: List[Wall] = []
    for index, wall in enumerate(walls):
        updated = dict(wall)
        updated["a"] = [snapped[2 * index][0], snapped[2 * index][1]]
        updated["b"] = [snapped[2 * index + 1][0], snapped[2 * index + 1][1]]
        welded.append(updated)
    return welded


def weld_endpoints(walls: List[Wall]) -> List[Wall]:
    """
    Weld to a fixpoint. One pass can leave two distinct cluster centroids within
    WELD_RADIUS_M of each other (single-linkage clusters' convex hulls may be closer than any
    pair of their members), so repeat until a pass changes nothing.
    """
    result = round_walls(walls)
    for _ in range(MAX_OUTER_PASSES):
        stepped = round_walls(_weld_once(result))
        if stepped == result:
            return result
        result = stepped
    raise RuntimeError("weld_endpoints did not converge; check WELD_RADIUS_M / freeze guard")


# ---------------------------------------------------------------------------------------
# Stage E: drop orphan shards
# ---------------------------------------------------------------------------------------


def _endpoint_key(point: Sequence[float]) -> Tuple[float, float]:
    return (round(float(point[0]), COORD_DECIMALS), round(float(point[1]), COORD_DECIMALS))


def drop_orphan_shards(walls: List[Wall]) -> List[Wall]:
    counts: Dict[Tuple[float, float], int] = {}
    for wall in walls:
        for key in (_endpoint_key(wall["a"]), _endpoint_key(wall["b"])):
            counts[key] = counts.get(key, 0) + 1

    kept: List[Wall] = []
    for wall in walls:
        if wall.get("note") is not None:
            kept.append(wall)  # authored decision, never trace noise
            continue
        if wall_length(wall) >= ORPHAN_MAX_LENGTH_M:
            kept.append(wall)
            continue
        shared = any(counts[key] > 1 for key in (_endpoint_key(wall["a"]), _endpoint_key(wall["b"])))
        if shared:
            kept.append(wall)
    return kept


# ---------------------------------------------------------------------------------------
# Stage F: T-junction snapping
# ---------------------------------------------------------------------------------------


def foot_on_wall(point: Point, wall: Wall) -> Optional[Tuple[float, Point, float]]:
    """Perpendicular foot of `point` on `wall`'s infinite line: (t, foot, distance)."""
    (ax, az), (bx, bz) = wall_points(wall)
    dx, dz = bx - ax, bz - az
    length_sq = dx * dx + dz * dz
    if length_sq <= 0.0:
        return None
    t = ((point[0] - ax) * dx + (point[1] - az) * dz) / length_sq
    foot = (ax + t * dx, az + t * dz)
    return t, foot, math.hypot(point[0] - foot[0], point[1] - foot[1])


def segment_point_distance(point: Point, wall: Wall) -> float:
    """Distance from a point to a wall as a finite SEGMENT (t clamped to [0, 1])."""
    (ax, az), (bx, bz) = wall_points(wall)
    dx, dz = bx - ax, bz - az
    length_sq = dx * dx + dz * dz
    t = 0.0 if length_sq <= 0.0 else max(0.0, min(1.0, ((point[0] - ax) * dx + (point[1] - az) * dz) / length_sq))
    return math.hypot(point[0] - (ax + t * dx), point[1] - (az + t * dz))


def free_endpoint_indices(walls: Sequence[Wall]) -> List[int]:
    """
    Endpoint indices not coincident with any OTHER wall's endpoint. Coincidence is judged on
    the rounded coordinate, the same key stage E uses, so "shared" means the same thing in
    both stages.
    """
    points = _endpoint_list(walls)
    counts: Dict[Tuple[float, float], List[int]] = {}
    for index, point in enumerate(points):
        counts.setdefault(_endpoint_key(point), []).append(index)
    free: List[int] = []
    for index, point in enumerate(points):
        owners = {other // 2 for other in counts[_endpoint_key(point)]}
        if len(owners) == 1:
            free.append(index)
    return free


def _snap_is_door_safe(
    endpoint_index: int,
    new_point: Point,
    points: Sequence[Point],
    walls: Sequence[Wall],
    protected: Sequence[Tuple[int, int, float]],
) -> bool:
    """
    The guardrail. A snap may not:
      1. shrink a protected door-band gap by more than DOOR_MAX_GAP_SHRINK_M (the same rule
         stage D's weld freeze uses), nor
      2. bring this endpoint within DOOR_MIN_GAP_M of a wall it was clear of before.
    Every candidate snap here moves at most T_SNAP_MAX_M (0.30 m) and every real door is at
    least DOOR_MIN_GAP_M (0.60 m), so this should never fire. It is checked, not assumed.
    """
    owner = endpoint_index // 2
    for i, j, original in protected:
        if endpoint_index not in (i, j):
            continue
        other = j if i == endpoint_index else i
        if other // 2 == owner:
            continue
        new_dist = math.hypot(new_point[0] - points[other][0], new_point[1] - points[other][1])
        if new_dist < original - DOOR_MAX_GAP_SHRINK_M:
            return False

    old_point = points[endpoint_index]
    for other_index, other_wall in enumerate(walls):
        if other_index == owner:
            continue
        before = segment_point_distance(old_point, other_wall)
        if before < DOOR_MIN_GAP_M:
            continue  # was already closer than a door; snapping cannot "close" it
        if segment_point_distance(new_point, other_wall) < DOOR_MIN_GAP_M:
            return False
    return True


def _snap_t_junctions_once(walls: List[Wall]) -> Tuple[List[Wall], int, int]:
    """
    One pass. Endpoints are visited in ascending index order and each snap is applied
    immediately, so the result depends only on the input list order, never on iteration order
    of a set or dict. Returns (walls, snaps applied, snaps rejected by the door guard).
    """
    result = [dict(w) for w in walls]
    protected = _protected_gaps(_endpoint_list(result))
    applied = 0
    rejected = 0

    for endpoint_index in free_endpoint_indices(result):
        owner = endpoint_index // 2
        points = _endpoint_list(result)
        point = points[endpoint_index]
        other_end = points[endpoint_index + 1 if endpoint_index % 2 == 0 else endpoint_index - 1]

        best: Optional[Tuple[float, int, Point]] = None
        for target_index, target in enumerate(result):
            if target_index == owner:
                continue
            if angle_diff_deg(wall_angle_deg(result[owner]), wall_angle_deg(target)) < T_SNAP_MIN_ANGLE_DEG:
                continue  # a bundle of near-parallel walls, not a junction
            hit = foot_on_wall(point, target)
            if hit is None:
                continue
            t, candidate_foot, distance = hit
            if not (T_SNAP_MIN_T <= t <= T_SNAP_MAX_T):
                continue
            if distance > T_SNAP_MAX_M:
                continue
            # Strictly-less keeps the LOWEST target index on a tie, so ties are deterministic.
            if best is None or distance < best[0]:
                best = (distance, target_index, candidate_foot)

        if best is None:
            continue
        distance, _target_index, new_point = best
        if distance <= T_SNAP_EPS_M:
            continue  # already landed; moving again would only chase rounding noise

        # Must not collapse the wall...
        new_length = math.hypot(new_point[0] - other_end[0], new_point[1] - other_end[1])
        if new_length < MIN_WALL_LENGTH_M:
            continue
        # ...nor flip it end over end.
        old_vec = (point[0] - other_end[0], point[1] - other_end[1])
        new_vec = (new_point[0] - other_end[0], new_point[1] - other_end[1])
        if old_vec[0] * new_vec[0] + old_vec[1] * new_vec[1] <= 0.0:
            continue
        if not _snap_is_door_safe(endpoint_index, new_point, points, result, protected):
            rejected += 1
            continue

        key = "a" if endpoint_index % 2 == 0 else "b"
        result[owner] = dict(result[owner])
        result[owner][key] = [new_point[0], new_point[1]]
        applied += 1

    return result, applied, rejected


SNAP_STATS = {"applied": 0, "rejected_by_door_guard": 0}


def snap_t_junctions(walls: List[Wall]) -> List[Wall]:
    """Snap to a fixpoint: each pass can free up a landing that the previous pass blocked."""
    result = round_walls(walls)
    for _ in range(MAX_OUTER_PASSES):
        stepped, applied, rejected = _snap_t_junctions_once(result)
        stepped = round_walls(stepped)
        SNAP_STATS["applied"] += applied
        SNAP_STATS["rejected_by_door_guard"] += rejected
        if stepped == result:
            return result
        result = stepped
    raise RuntimeError("snap_t_junctions did not converge; check T_SNAP_MAX_M / T_SNAP_EPS_M")


# ---------------------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------------------


def clean_walls(walls: Sequence[Wall]) -> List[Wall]:
    """Run A, B, C, D, A, E, F, D, A to an overall fixpoint. Deterministic and idempotent."""
    result = round_walls(walls)
    for _ in range(MAX_OUTER_PASSES):
        before = result
        stepped = drop_degenerate(before)
        stepped = dedupe_stacked(stepped)
        stepped = merge_collinear_chains(stepped)
        stepped = weld_endpoints(stepped)
        stepped = drop_degenerate(stepped)
        stepped = drop_orphan_shards(stepped)
        # F lands free ends on the walls they meet, then D re-welds so any endpoint that a
        # snap made coincident registers as genuinely shared, and A clears anything collapsed.
        stepped = snap_t_junctions(stepped)
        stepped = weld_endpoints(stepped)
        stepped = drop_degenerate(stepped)
        stepped = round_walls(stepped)
        if stepped == before:
            return result
        result = stepped
    raise RuntimeError("clean_walls did not reach a fixpoint; check the tolerances")


# ---------------------------------------------------------------------------------------
# Stats / reporting
# ---------------------------------------------------------------------------------------

# Reporting-only thresholds: these describe the defects the pipeline is judged on, and are
# deliberately the ones the original defect measurement used, not the pipeline's own.
REPORT_STACK_ANGLE_DEG = 6.0
REPORT_STACK_PERP_M = 0.35
REPORT_FRAGMENT_M = 0.80
REPORT_UNWELDED_M = 0.12
# A free endpoint sitting this close to another wall's BODY (its interior, not its tip) is an
# unlanded T-junction: at 0.15 m wall thickness it renders as a hairline crack.
REPORT_TJUNCTION_M = 0.60
REPORT_TJUNCTION_MIN_T = 0.08
REPORT_TJUNCTION_MAX_T = 0.92
# A wall with no other wall within this distance of either end is floating in space.
REPORT_ISOLATED_M = 0.60


def _report_free_endpoints(walls: Sequence[Wall]) -> int:
    return len(free_endpoint_indices(walls))


def _report_tjunction_gaps(walls: Sequence[Wall]) -> int:
    points = _endpoint_list(walls)
    count = 0
    for index in free_endpoint_indices(walls):
        owner = index // 2
        for target_index, target in enumerate(walls):
            if target_index == owner:
                continue
            hit = foot_on_wall(points[index], target)
            if hit is None:
                continue
            t, _foot, distance = hit
            if REPORT_TJUNCTION_MIN_T < t < REPORT_TJUNCTION_MAX_T and distance <= REPORT_TJUNCTION_M:
                count += 1
                break
    return count


def _report_floating_walls(walls: Sequence[Wall]) -> int:
    points = _endpoint_list(walls)
    count = 0
    for index, _wall in enumerate(walls):
        nearest = min(
            (
                min(
                    segment_point_distance(points[2 * index], other),
                    segment_point_distance(points[2 * index + 1], other),
                )
                for other_index, other in enumerate(walls)
                if other_index != index
            ),
            default=float("inf"),
        )
        if nearest > REPORT_ISOLATED_M:
            count += 1
    return count


def _report_stacked_pairs(walls: Sequence[Wall]) -> int:
    count = 0
    for i in range(len(walls)):
        for j in range(i + 1, len(walls)):
            wall_a, wall_b = walls[i], walls[j]
            if angle_diff_deg(wall_angle_deg(wall_a), wall_angle_deg(wall_b)) > REPORT_STACK_ANGLE_DEG:
                continue
            longer, shorter = (wall_a, wall_b) if wall_length(wall_a) >= wall_length(wall_b) else (wall_b, wall_a)
            origin, direction = _pt(longer["a"]), unit_direction(longer)
            s0, s1 = wall_points(shorter)
            if max(
                perpendicular_distance(s0, origin, direction),
                perpendicular_distance(s1, origin, direction),
            ) <= REPORT_STACK_PERP_M:
                l0, l1 = wall_points(longer)
                long_lo, long_hi = sorted((project(l0, origin, direction), project(l1, origin, direction)))
                short_lo, short_hi = sorted((project(s0, origin, direction), project(s1, origin, direction)))
                if min(long_hi, short_hi) - max(long_lo, short_lo) > 0.0:
                    count += 1
    return count


def _report_unwelded_pairs(walls: Sequence[Wall]) -> int:
    points = _endpoint_list(walls)
    count = 0
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if i // 2 == j // 2:
                continue
            dist = math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1])
            if 0.0 < dist < REPORT_UNWELDED_M:
                count += 1
    return count


def wall_stats(walls: Sequence[Wall]) -> Dict[str, Any]:
    return {
        "walls": len(walls),
        "total_length_m": sum(wall_length(w) for w in walls),
        "stacked_pairs": _report_stacked_pairs(walls),
        "fragments_under_0_8m": sum(1 for w in walls if wall_length(w) < REPORT_FRAGMENT_M),
        "unwelded_endpoint_pairs": _report_unwelded_pairs(walls),
        "free_endpoints": _report_free_endpoints(walls),
        "tjunction_gaps": _report_tjunction_gaps(walls),
        "floating_walls": _report_floating_walls(walls),
        "glass_walls": sum(1 for w in walls if w.get("glass")),
        "walls_with_notes": sum(1 for w in walls if w.get("note") is not None),
        "shortest_m": min((wall_length(w) for w in walls), default=0.0),
    }


def print_report(before: Dict[str, Any], after: Dict[str, Any]) -> None:
    rows = [
        ("wall count", "walls", "{:.0f}"),
        ("total length (m)", "total_length_m", "{:.1f}"),
        ("stacked pairs remaining", "stacked_pairs", "{:.0f}"),
        ("fragments < 0.8 m", "fragments_under_0_8m", "{:.0f}"),
        ("unwelded endpoint pairs < 0.12 m", "unwelded_endpoint_pairs", "{:.0f}"),
        ("free endpoints", "free_endpoints", "{:.0f}"),
        ("unlanded T-junction gaps", "tjunction_gaps", "{:.0f}"),
        ("floating (isolated) walls", "floating_walls", "{:.0f}"),
        ("glass walls", "glass_walls", "{:.0f}"),
        ("walls carrying a note", "walls_with_notes", "{:.0f}"),
        ("shortest wall (m)", "shortest_m", "{:.3f}"),
    ]
    label_width = max(len(r[0]) for r in rows)
    print(f"{'metric'.ljust(label_width)}  {'before':>10}  {'after':>10}")
    print(f"{'-' * label_width}  {'-' * 10}  {'-' * 10}")
    for label, key, fmt in rows:
        print(f"{label.ljust(label_width)}  {fmt.format(before[key]):>10}  {fmt.format(after[key]):>10}")


# ---------------------------------------------------------------------------------------
# Read / write
# ---------------------------------------------------------------------------------------


def read_plan(path: str) -> Tuple[Dict[str, Any], str]:
    """Returns the parsed plan and the newline convention the file on disk uses."""
    with open(path, "rb") as handle:
        raw = handle.read()
    newline = "\r\n" if raw.count(b"\r\n") > 0 else "\n"
    return json.loads(raw.decode("utf-8")), newline


def cleanup_sentence(after: Dict[str, Any]) -> str:
    """
    Describes the RESULT, never the delta: the written file is a fixpoint of this pipeline, so
    a result-only sentence keeps re-runs byte identical.
    """
    return (
        f" {NOTE_MARKER} the walls array was rewritten for renderability. Stacked duplicate "
        f"segments (the raster trace emitted many physical walls twice) were fused via a "
        f"total-least-squares fit, near-collinear runs separated by less than "
        f"{CHAIN_MAX_GAP_M:.2f} m were joined, endpoints within {WELD_RADIUS_M:.2f} m were "
        f"welded to a common corner, segments under {MIN_WALL_LENGTH_M:.2f} m plus "
        f"free-floating stubs under {ORPHAN_MAX_LENGTH_M:.2f} m were dropped, and every "
        f"remaining free wall end within {T_SNAP_MAX_M:.2f} m of another wall's body was "
        f"landed on the exact perpendicular foot of it so partitions form clean T-junctions "
        f"instead of hairline cracks, leaving "
        f"{after['walls']} segments. Wall dimensions and angles are therefore adjusted, not "
        f"surveyed. No merge ever bridged a gap of {DOOR_MIN_GAP_M:.2f} m or wider and welding "
        f"was frozen wherever it would narrow a door-sized opening, so every door opening in "
        f"the trace survives; glass flags and authored per-wall notes are carried onto the "
        f"merged descendants."
    )


def strip_previous_sentence(note: str) -> str:
    index = note.find(NOTE_MARKER)
    if index == -1:
        return note
    return note[:index].rstrip()


def render_plan(plan: Dict[str, Any], newline: str) -> bytes:
    text = json.dumps(plan, indent=2, ensure_ascii=False)
    if newline != "\n":
        text = text.replace("\n", newline)
    return text.encode("utf-8")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    parser.add_argument("--report", action="store_true", help="print the before/after stats table")
    args = parser.parse_args(argv)

    plan, newline = read_plan(SERVER_PLAN_PATH)
    original_walls: List[Wall] = plan["walls"]

    before = wall_stats(round_walls(original_walls))
    cleaned = clean_walls(original_walls)
    after = wall_stats(cleaned)

    # Idempotency self-check, always run: the pipeline must be a fixpoint on its own output.
    if clean_walls(cleaned) != cleaned:
        print("ERROR: pipeline is not idempotent (a second pass changed the walls)", file=sys.stderr)
        return 2

    # Notes must never be silently dropped.
    original_notes = {w["note"] for w in original_walls if w.get("note") is not None}
    surviving_notes = "\n\n".join(w["note"] for w in cleaned if w.get("note") is not None)
    missing = sorted(n for n in original_notes if n not in surviving_notes)
    if missing:
        print(f"ERROR: {len(missing)} wall note(s) were lost by the cleanup", file=sys.stderr)
        for note in missing:
            print(f"  - {note[:120]}...", file=sys.stderr)
        return 3

    if args.report:
        print_report(before, after)
        print()

    plan["walls"] = cleaned
    if isinstance(plan.get("note"), str):
        plan["note"] = strip_previous_sentence(plan["note"]) + cleanup_sentence(after)

    payload = render_plan(plan, newline)

    if args.dry_run:
        print(f"DRY RUN: would write {len(payload)} bytes to:")
        print(f"  {SERVER_PLAN_PATH}")
        print(f"  {CLIENT_PLAN_PATH}")
        return 0

    for path in (SERVER_PLAN_PATH, CLIENT_PLAN_PATH):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(payload)
    print(f"Wrote {len(payload)} bytes to both copies ({after['walls']} walls).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
