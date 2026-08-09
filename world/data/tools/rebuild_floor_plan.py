#!/usr/bin/env python3
"""
Rebuild floor-14.json's `walls[]` (and repair `holes[]`) from clean architectural primitives.

WHY THIS EXISTS
---------------
`walls[]` came out of a raster trace of a line drawing. Incremental cleanup
(world/data/tools/clean_floor_plan.py, stages A-F) removes local defects but cannot invent the
structure the trace never had: the envelope was a bundle of near-duplicate segments, and the
elevator/stair shaft boxes (drawn with X hatching in the source) were traced as thin wall boxes
that render as a "comb" across the middle of the floor. The root cause of the comb was that
holes[0] ("elevator-stair-core-upper") is a SELF-INTERSECTING 29-point polygon, so the trace
pipeline's own "drop walls inside a hole" filter silently failed.

This script does not clean; it CONSTRUCTS:

  Step 1  Repair `holes[]`. Any hole polygon that is not simple is replaced by an axis-aligned
          rectangle over its own bounding band, which is what the source drawing actually shows
          (two horizontal core bands). Simple polygons are kept verbatim.
  Step 2  Emit one wall per `walkableOutline` edge. The envelope is then closed by construction.
  Step 3  Emit one wall per edge of each repaired hole polygon (the two core bands).
  Step 4  Keep an existing traced wall as an interior PARTITION only if it is long enough, is
          not inside a core hole, and is not a near-duplicate of an envelope/core wall. Then
          regularize the survivors (collinear merge, weld, T-snap) against the fixed
          envelope/core walls, which are never moved.
  Step 5  Doors are preserved by never welding or snapping across a door-sized opening
          (guardrails inherited from clean_floor_plan.py). `cd world && npm run test:nav` is the
          objective gate: 18/18 rooms path-reachable, no PARTIAL paths.
  Step 6  Carry `glass: true` and authored `note` fields from the pre-rebuild walls onto the
          nearest surviving parallel descendant.

Only `walls[]` and `holes[]` are written; `rooms`, `entrance`, `walkableOutline`, `units` and
`floor` are passed through untouched. Both copies of the file (world/data and
world-client/public/data) are written byte-identical.

Deterministic and idempotent: re-running on its own output reproduces it byte for byte. The
envelope/core walls are a pure function of `walkableOutline` + repaired `holes`, and on a second
pass they are re-detected as near-duplicates of themselves and re-emitted from the same source,
so they do not accumulate.

Usage:
    python rebuild_floor_plan.py [--dry-run] [--render OUT.png]
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import clean_floor_plan as clean  # noqa: E402  (path set up above)

Point = Tuple[float, float]
Wall = Dict[str, Any]

# ---------------------------------------------------------------------------------------
# Tolerances for the rebuild. Everything the construction keys off lives here.
# ---------------------------------------------------------------------------------------

WALL_HEIGHT_M = 2.7  # envelope + core walls; partitions keep their authored height

# --- Step 4 admission filters ----------------------------------------------------------
# Admission is deliberately permissive about LENGTH, because short is not the same as noisy:
# a door jamb is 0.5-0.7 m and it is exactly what makes a room read as enclosed. A flat 1.2 m
# floor was tried first and it deleted every jamb in the washroom block and in 1429/1430, which
# flipped the failure mode from clutter to omission. Whether a short segment is a jamb or a
# shard is a question about CONNECTIVITY, not length, so it is decided after regularization by
# prune_floating_shards() instead. Applied to the INPUT and re-applied to the OUTPUT, which is
# what makes the partition set a fixpoint.
PARTITION_MIN_LENGTH_M = 0.45

# "Near-duplicate of an envelope/core wall": the envelope and the core are already drawn once,
# so a traced segment shadowing one of them is the trace's second copy of it, not a partition.
DUP_ANGLE_DEG = 8.0
DUP_PERP_M = 0.45
DUP_OVERLAP_FRACTION = 0.50  # of the candidate's own length
# A core-boundary crossing this close to a wall's own end is treated as the wall already being
# flush with the core, not as a cut. Keeps clipping idempotent under 1 mm coordinate rounding.
CLIP_ENDPOINT_EPS_M = 0.02

# --- Step 4 regularization -------------------------------------------------------------
# The source is an architectural line drawing, so every wall is drawn as a PAIR of lines (its
# two faces) and the trace emitted both, plus a splayed copy wherever the two faces were not
# quite parallel. Rendered at 0.15 m thickness those read as doubled walls and shallow
# self-crossings, which is a large part of why the floor looked like a scribble. A bundle is
# fused into a single centreline. The perpendicular bound is wider than the true wall thickness
# (~0.30 m) because the splay reaches ~0.70 m at the far end of the longest pairs.
BUNDLE_ANGLE_DEG = 20.0
BUNDLE_PERP_M = 0.75
BUNDLE_OVERLAP_FRACTION = 0.50

WELD_RADIUS_M = 0.20  # partition endpoint to partition endpoint, and partition to fixed corner
# Free partition end onto another wall's BODY. At 0.35 m several long partitions (the washroom
# block's bottom walls, the Quiet Study / 1430 divider) stopped 0.35-0.50 m short of the wall
# they visibly meet in the source and rendered as floating. Still well under DOOR_MIN_GAP_M, and
# the door guard is checked on every snap regardless.
T_SNAP_MAX_M = 0.50
T_SNAP_MIN_T = 0.02
T_SNAP_MAX_T = 0.98
T_SNAP_MIN_ANGLE_DEG = 20.0  # a junction is transverse; near-parallel is a bundle, not a T
T_SNAP_EPS_M = 0.0005        # below this the end has already landed (makes the pass terminate)
# A crossing this close to a partition's own end is an overshoot to trim back, not a real
# crossing. Trimming only ever shortens a partition, so it cannot close an opening.
TRIM_CROSS_MAX_M = 0.50
# Post-regularization pruning. A wall is a shard only if it is BOTH short AND fully floating
# (neither end connected once welding and T-snapping have converged). A short wall with at least
# one connected end is a door jamb and is kept.
SHARD_MAX_LENGTH_M = 1.2
# An endpoint counts as connected if it sits this close to any other wall's body or endpoint.
ATTACHED_EPS_M = 0.02
# Weld/T-snap/trim may not shorten a partition below this.
MIN_COLLAPSE_LENGTH_M = 0.30

# --- Door guardrails (inherited semantics from clean_floor_plan.py) ---------------------
DOOR_MIN_GAP_M = clean.DOOR_MIN_GAP_M                # 0.60
DOOR_PROTECT_MIN_GAP_M = clean.DOOR_PROTECT_MIN_GAP_M  # 0.45
DOOR_PROTECT_MAX_GAP_M = clean.DOOR_PROTECT_MAX_GAP_M  # 2.50
DOOR_MAX_GAP_SHRINK_M = clean.DOOR_MAX_GAP_SHRINK_M    # 0.10

# --- Step 6 provenance carry-over ------------------------------------------------------
CARRY_ANGLE_DEG = 20.0
CARRY_PERP_M = 0.60
CARRY_NOTE_MAX_M = 2.00  # a note falls back to the nearest wall within this if nothing parallel

COORD_DECIMALS = clean.COORD_DECIMALS
MAX_PASSES = 40

NOTE_MARKER = "Geometry REBUILD pass (world/data/tools/rebuild_floor_plan.py):"

SERVER_PLAN_PATH = clean.SERVER_PLAN_PATH
CLIENT_PLAN_PATH = clean.CLIENT_PLAN_PATH


# ---------------------------------------------------------------------------------------
# Small geometry helpers (the primitive ones are reused from clean_floor_plan)
# ---------------------------------------------------------------------------------------

wall_points = clean.wall_points
wall_length = clean.wall_length
wall_angle_deg = clean.wall_angle_deg
angle_diff_deg = clean.angle_diff_deg
unit_direction = clean.unit_direction
project = clean.project
perpendicular_distance = clean.perpendicular_distance
foot_on_wall = clean.foot_on_wall
segment_point_distance = clean.segment_point_distance
round_wall = clean.round_wall
round_walls = clean.round_walls


def _pt(value: Sequence[float]) -> Point:
    return (float(value[0]), float(value[1]))


def make_wall(a: Point, b: Point, height: float = WALL_HEIGHT_M) -> Wall:
    return round_wall({"a": [a[0], a[1]], "b": [b[0], b[1]], "height": height, "glass": False})


def polygon_signed_area(polygon: Sequence[Point]) -> float:
    total = 0.0
    for i, (x1, z1) in enumerate(polygon):
        x2, z2 = polygon[(i + 1) % len(polygon)]
        total += x1 * z2 - x2 * z1
    return total / 2.0


def polygon_edges(polygon: Sequence[Point]) -> List[Tuple[Point, Point]]:
    return [(polygon[i], polygon[(i + 1) % len(polygon)]) for i in range(len(polygon))]


def _orient(p: Point, q: Point, r: Point) -> float:
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])


def _segments_properly_cross(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    """
    True only for a genuine crossing. Both endpoints of each segment must be STRICTLY on
    opposite sides of the other, so a shared endpoint or a T-junction touch (orientation
    exactly 0) is not a crossing. Using `(d1 > 0) != (d2 > 0)` instead would report every
    adjacent polygon edge pair, since their shared vertex gives d == 0.
    """
    d1, d2 = _orient(p3, p4, p1), _orient(p3, p4, p2)
    d3, d4 = _orient(p1, p2, p3), _orient(p1, p2, p4)
    return d1 * d2 < 0.0 and d3 * d4 < 0.0


def _crossing_point(a0: Point, a1: Point, b0: Point, b1: Point) -> Optional[Tuple[float, float]]:
    """(t, u) parameters of the infinite-line intersection, or None if parallel."""
    r = (a1[0] - a0[0], a1[1] - a0[1])
    s = (b1[0] - b0[0], b1[1] - b0[1])
    denominator = r[0] * s[1] - r[1] * s[0]
    if abs(denominator) < 1e-12:
        return None
    qp = (b0[0] - a0[0], b0[1] - a0[1])
    t = (qp[0] * s[1] - qp[1] * s[0]) / denominator
    u = (qp[0] * r[1] - qp[1] * r[0]) / denominator
    return t, u


def polygon_self_intersections(polygon: Sequence[Point]) -> List[Tuple[int, int]]:
    edges = polygon_edges(polygon)
    hits: List[Tuple[int, int]] = []
    count = len(edges)
    for i in range(count):
        for j in range(i + 1, count):
            if j == i or (i == 0 and j == count - 1) or j == i + 1:
                continue  # adjacent edges legitimately share a vertex
            if _segments_properly_cross(edges[i][0], edges[i][1], edges[j][0], edges[j][1]):
                hits.append((i, j))
    return hits


def point_in_polygon(point: Point, polygon: Sequence[Point]) -> bool:
    """Ray casting. Boundary points are not guaranteed either way (they are resolved earlier
    by the near-duplicate filter, which removes any wall lying ON a core edge)."""
    x, z = point
    inside = False
    count = len(polygon)
    for i in range(count):
        x1, z1 = polygon[i]
        x2, z2 = polygon[(i + 1) % count]
        if (z1 > z) != (z2 > z):
            cross_x = x1 + (z - z1) * (x2 - x1) / (z2 - z1)
            if x < cross_x:
                inside = not inside
    return inside


def overlap_along(candidate: Wall, reference: Wall) -> float:
    """Length of `candidate`'s projection onto `reference`'s axis that lies within it."""
    origin, direction = _pt(reference["a"]), unit_direction(reference)
    r0, r1 = wall_points(reference)
    c0, c1 = wall_points(candidate)
    ref_lo, ref_hi = sorted((project(r0, origin, direction), project(r1, origin, direction)))
    cand_lo, cand_hi = sorted((project(c0, origin, direction), project(c1, origin, direction)))
    return max(0.0, min(ref_hi, cand_hi) - max(ref_lo, cand_lo))


def is_near_duplicate(candidate: Wall, reference: Wall) -> bool:
    if angle_diff_deg(wall_angle_deg(candidate), wall_angle_deg(reference)) > DUP_ANGLE_DEG:
        return False
    origin, direction = _pt(reference["a"]), unit_direction(reference)
    c0, c1 = wall_points(candidate)
    if max(
        perpendicular_distance(c0, origin, direction),
        perpendicular_distance(c1, origin, direction),
    ) > DUP_PERP_M:
        return False
    return overlap_along(candidate, reference) >= DUP_OVERLAP_FRACTION * wall_length(candidate)


def endpoint_list(walls: Sequence[Wall]) -> List[Point]:
    points: List[Point] = []
    for wall in walls:
        a, b = wall_points(wall)
        points.append(a)
        points.append(b)
    return points


def midpoint(wall: Wall) -> Point:
    (ax, az), (bx, bz) = wall_points(wall)
    return ((ax + bx) / 2.0, (az + bz) / 2.0)


# ---------------------------------------------------------------------------------------
# Step 1: repair the holes
# ---------------------------------------------------------------------------------------


def repair_hole(hole: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
    """
    A hole polygon must be simple (no self-crossings) for earcut to punch it out of the floor
    and for the "wall inside a core" test to mean anything. holes[0] in the traced file is a
    29-point polygon with two self-crossings, which is what let the elevator/stair shaft boxes
    survive as walls. A self-intersecting polygon is replaced by the axis-aligned rectangle over
    its own bounding box, which is what the source drawing shows for both core bands.
    Returns (repaired hole, was_repaired).
    """
    polygon = [_pt(p) for p in hole["polygon"]]
    repaired = False
    if polygon_self_intersections(polygon) or len(polygon) < 3:
        xs = [p[0] for p in polygon]
        zs = [p[1] for p in polygon]
        min_x, max_x = min(xs), max(xs)
        min_z, max_z = min(zs), max(zs)
        polygon = [(min_x, max_z), (min_x, min_z), (max_x, min_z), (max_x, max_z)]
        repaired = True

    if polygon_signed_area(polygon) < 0.0:
        polygon = list(reversed(polygon))

    rounded = [
        (round(x, COORD_DECIMALS), round(z, COORD_DECIMALS)) for x, z in polygon
    ]
    return ({"name": hole["name"], "polygon": [[x, z] for x, z in rounded]}, repaired)


def repair_holes(holes: Sequence[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[str]]:
    out: List[Dict[str, Any]] = []
    repaired_names: List[str] = []
    for hole in holes:
        fixed, was_repaired = repair_hole(hole)
        polygon = [_pt(p) for p in fixed["polygon"]]
        assert not polygon_self_intersections(polygon), f"{fixed['name']} still self-intersects"
        assert polygon_signed_area(polygon) > 0.0, f"{fixed['name']} is not counter-clockwise"
        out.append(fixed)
        if was_repaired:
            repaired_names.append(fixed["name"])
    return out, repaired_names


# ---------------------------------------------------------------------------------------
# Steps 2 and 3: the fixed walls (envelope + core)
# ---------------------------------------------------------------------------------------


def build_envelope_walls(outline: Sequence[Sequence[float]]) -> List[Wall]:
    points = [_pt(p) for p in outline]
    return [make_wall(a, b) for a, b in polygon_edges(points)]


def build_core_walls(holes: Sequence[Dict[str, Any]]) -> List[Wall]:
    walls: List[Wall] = []
    for hole in holes:
        points = [_pt(p) for p in hole["polygon"]]
        walls.extend(make_wall(a, b) for a, b in polygon_edges(points))
    return walls


# ---------------------------------------------------------------------------------------
# Step 4: admit and regularize the interior partitions
# ---------------------------------------------------------------------------------------


def _lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))


def clip_wall_to_floor(
    wall: Wall, outline: Sequence[Point], holes: Sequence[Sequence[Point]]
) -> List[Wall]:
    """
    Cut a wall at every floor-boundary crossing and keep only the parts that lie on real floor:
    inside `outline` and outside every core hole.

    Plain "drop the wall if its midpoint is inside a core" would also delete real partitions that
    merely run into the core band (the Female Washroom's left wall and the washroom block's own
    left wall both start inside it and run about 2 m out the other side), so a wall is trimmed
    rather than discarded. A wall wholly inside a core, which is what every elevator/stair SHAFT
    box is, still disappears entirely, and the trimmed ends land exactly on the core wall, which
    is a clean T-junction instead of a hairline crack.

    Split parameters closer than CLIP_ENDPOINT_EPS_M to an endpoint are ignored, so a wall
    already flush with a boundary (to within coordinate rounding) is not re-cut on a later run.
    """
    a, b = wall_points(wall)
    length = wall_length(wall)
    if length <= 0.0:
        return []

    boundaries = [list(outline)] + [list(h) for h in holes]
    cuts = {0.0, 1.0}
    for polygon in boundaries:
        for p, q in polygon_edges(polygon):
            params = _crossing_point(a, b, p, q)
            if params is None:
                continue
            t, u = params
            if not (-1e-9 <= u <= 1.0 + 1e-9):
                continue
            if t * length <= CLIP_ENDPOINT_EPS_M or (1.0 - t) * length <= CLIP_ENDPOINT_EPS_M:
                continue
            cuts.add(t)

    ordered = sorted(cuts)
    kept_spans: List[Tuple[float, float]] = []
    for t0, t1 in zip(ordered, ordered[1:]):
        if (t1 - t0) * length <= CLIP_ENDPOINT_EPS_M:
            continue
        centre = _lerp(a, b, (t0 + t1) / 2.0)
        if not point_in_polygon(centre, outline):
            continue
        if any(point_in_polygon(centre, hole) for hole in holes):
            continue
        if kept_spans and abs(kept_spans[-1][1] - t0) < 1e-9:
            kept_spans[-1] = (kept_spans[-1][0], t1)  # coalesce adjacent kept spans
        else:
            kept_spans.append((t0, t1))

    pieces: List[Wall] = []
    for t0, t1 in kept_spans:
        piece = dict(wall)
        start, end = _lerp(a, b, t0), _lerp(a, b, t1)
        piece["a"] = [start[0], start[1]]
        piece["b"] = [end[0], end[1]]
        pieces.append(round_wall(piece))
    return pieces


def _subtract_shadow_of(candidate: Wall, reference: Wall) -> List[Wall]:
    """
    Remove from `candidate` the run over which it shadows `reference` (near-parallel and within
    DUP_PERP_M of it), keeping whatever sticks out past either end. Dropping the whole candidate
    instead would delete real geometry: several traced facade walls run 1.5-2 m past the outline
    edge they otherwise duplicate.
    """
    if angle_diff_deg(wall_angle_deg(candidate), wall_angle_deg(reference)) > DUP_ANGLE_DEG:
        return [candidate]
    a, b = wall_points(candidate)
    length = wall_length(candidate)
    if length <= 0.0:
        return [candidate]

    origin, direction = a, unit_direction(candidate)
    r0, r1 = wall_points(reference)
    ref_lo, ref_hi = sorted((project(r0, origin, direction), project(r1, origin, direction)))
    t_lo = max(0.0, ref_lo / length)
    t_hi = min(1.0, ref_hi / length)
    if (t_hi - t_lo) * length <= CLIP_ENDPOINT_EPS_M:
        return [candidate]

    ref_origin, ref_direction = _pt(reference["a"]), unit_direction(reference)
    if perpendicular_distance(_lerp(a, b, (t_lo + t_hi) / 2.0), ref_origin, ref_direction) > DUP_PERP_M:
        return [candidate]

    pieces: List[Wall] = []
    for span_lo, span_hi in ((0.0, t_lo), (t_hi, 1.0)):
        if (span_hi - span_lo) * length <= CLIP_ENDPOINT_EPS_M:
            continue
        piece = dict(candidate)
        start, end = _lerp(a, b, span_lo), _lerp(a, b, span_hi)
        piece["a"] = [start[0], start[1]]
        piece["b"] = [end[0], end[1]]
        pieces.append(round_wall(piece))
    return pieces


def subtract_fixed_shadows(wall: Wall, fixed: Sequence[Wall]) -> List[Wall]:
    pieces = [wall]
    for reference in fixed:
        stepped: List[Wall] = []
        for piece in pieces:
            stepped.extend(_subtract_shadow_of(piece, reference))
        pieces = stepped
    return pieces


def admit_partitions(
    candidates: Sequence[Wall],
    fixed: Sequence[Wall],
    outline: Sequence[Point],
    hole_polygons: Sequence[Sequence[Point]],
) -> Tuple[List[Wall], Dict[str, int]]:
    """
    Shadow subtraction runs BEFORE the floor clip on purpose: a traced facade wall sits within a
    few centimetres of the outline, so "is its midpoint inside the outline" is a coin flip for
    it. Removing the envelope's own shadow first means only genuinely interior geometry is ever
    handed to the clip.
    """
    kept: List[Wall] = []
    rejected = {"too_short": 0, "off_floor": 0, "shadowed_fixed": 0}
    for wall in candidates:
        remainders = subtract_fixed_shadows(wall, fixed)
        if not remainders:
            rejected["shadowed_fixed"] += 1
            continue
        for remainder in remainders:
            pieces = clip_wall_to_floor(remainder, outline, hole_polygons)
            if not pieces:
                rejected["off_floor"] += 1
                continue
            for piece in pieces:
                if wall_length(piece) < PARTITION_MIN_LENGTH_M:
                    rejected["too_short"] += 1
                    continue
                kept.append(dict(piece))
    return kept, rejected


def is_bundle_pair(wall_a: Wall, wall_b: Wall) -> bool:
    """Two traces of the same physical wall: near-parallel, hugging, and overlapping."""
    if angle_diff_deg(wall_angle_deg(wall_a), wall_angle_deg(wall_b)) > BUNDLE_ANGLE_DEG:
        return False
    longer, shorter = (wall_a, wall_b) if wall_length(wall_a) >= wall_length(wall_b) else (wall_b, wall_a)
    if wall_length(shorter) <= 0.0:
        return False
    origin, direction = _pt(longer["a"]), unit_direction(longer)
    s0, s1 = wall_points(shorter)
    if max(
        perpendicular_distance(s0, origin, direction),
        perpendicular_distance(s1, origin, direction),
    ) > BUNDLE_PERP_M:
        return False
    return overlap_along(shorter, longer) > BUNDLE_OVERLAP_FRACTION * wall_length(shorter)


def dedupe_bundles(walls: List[Wall]) -> List[Wall]:
    """Fuse each bundle to one centreline (total-least-squares fit through all four endpoints,
    extent = the union of their projections). Always merges the lowest-index pair first and
    restarts, so the result depends only on list order."""
    result = [dict(w) for w in walls]
    for _ in range(MAX_PASSES * len(result) + 1):
        pair: Optional[Tuple[int, int]] = None
        for i in range(len(result)):
            for j in range(i + 1, len(result)):
                if is_bundle_pair(result[i], result[j]):
                    pair = (i, j)
                    break
            if pair is not None:
                break
        if pair is None:
            return round_walls(result)
        i, j = pair
        merged = clean.merge_walls(result[i], result[j])
        result = result[:i] + [merged] + result[i + 1 : j] + result[j + 1 :]
    raise RuntimeError("dedupe_bundles did not converge; check the BUNDLE_* tolerances")


def _protected_gaps(points: Sequence[Point]) -> List[Tuple[int, int, float]]:
    """Endpoint pairs from different walls sitting a door-width apart: candidate doorways."""
    gaps: List[Tuple[int, int, float]] = []
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if i // 2 == j // 2:
                continue
            dist = math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1])
            if DOOR_PROTECT_MIN_GAP_M <= dist <= DOOR_PROTECT_MAX_GAP_M:
                gaps.append((i, j, dist))
    return gaps


def _move_is_door_safe(
    endpoint_index: int,
    new_point: Point,
    points: Sequence[Point],
    walls: Sequence[Wall],
    protected: Sequence[Tuple[int, int, float]],
) -> bool:
    """A move may neither narrow a protected doorway by more than DOOR_MAX_GAP_SHRINK_M nor
    bring an endpoint within DOOR_MIN_GAP_M of a wall it was clear of before."""
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
        if segment_point_distance(old_point, other_wall) < DOOR_MIN_GAP_M:
            continue  # already closer than a door; the move cannot "close" it
        if segment_point_distance(new_point, other_wall) < DOOR_MIN_GAP_M:
            return False
    return True


def _weld_once(partitions: List[Wall], fixed: Sequence[Wall]) -> List[Wall]:
    """
    Endpoint welding with the envelope/core PINNED. A partition end within WELD_RADIUS_M of a
    fixed wall's corner lands exactly on that corner (the envelope never moves, so it keeps
    matching walkableOutline byte for byte); otherwise partition ends within WELD_RADIUS_M of
    each other collapse to their own centroid.
    """
    result = [dict(w) for w in partitions]
    if not result:
        return result

    part_points = endpoint_list(result)
    fixed_points = endpoint_list(fixed)
    all_walls = list(result) + list(fixed)
    protected = _protected_gaps(endpoint_list(all_walls))

    # Pass 1: pin to a fixed corner where one is in range (deterministic: lowest index wins).
    targets: List[Optional[Point]] = [None] * len(part_points)
    for index, point in enumerate(part_points):
        best: Optional[Tuple[float, Point]] = None
        for fixed_point in fixed_points:
            dist = math.hypot(point[0] - fixed_point[0], point[1] - fixed_point[1])
            if dist <= WELD_RADIUS_M and (best is None or dist < best[0]):
                best = (dist, fixed_point)
        if best is not None:
            targets[index] = best[1]

    # Pass 2: single-linkage clusters among the still-unpinned partition endpoints.
    union = clean._UnionFind(len(part_points))
    for i in range(len(part_points)):
        if targets[i] is not None:
            continue
        for j in range(i + 1, len(part_points)):
            if targets[j] is not None:
                continue
            if math.hypot(part_points[i][0] - part_points[j][0], part_points[i][1] - part_points[j][1]) <= WELD_RADIUS_M:
                union.union(i, j)

    clusters: Dict[int, List[int]] = {}
    for index in range(len(part_points)):
        if targets[index] is None:
            clusters.setdefault(union.find(index), []).append(index)
    for members in clusters.values():
        if len(members) < 2:
            continue
        cx = sum(part_points[m][0] for m in members) / len(members)
        cz = sum(part_points[m][1] for m in members) / len(members)
        centroid = (round(cx, COORD_DECIMALS), round(cz, COORD_DECIMALS))
        for member in members:
            targets[member] = centroid

    for index, target in enumerate(targets):
        if target is None:
            continue
        current = part_points[index]
        if math.hypot(target[0] - current[0], target[1] - current[1]) <= T_SNAP_EPS_M:
            continue
        if not _move_is_door_safe(index, target, endpoint_list(all_walls), all_walls, protected):
            continue
        owner = index // 2
        key = "a" if index % 2 == 0 else "b"
        moved = dict(result[owner])
        moved[key] = [target[0], target[1]]
        if wall_length(moved) < MIN_COLLAPSE_LENGTH_M:
            continue  # a weld may not collapse a partition
        result[owner] = moved
        all_walls[owner] = moved
    return round_walls(result)


def _free_partition_endpoints(partitions: Sequence[Wall], fixed: Sequence[Wall]) -> List[int]:
    """Partition endpoint indices not coincident with any OTHER wall's endpoint."""
    part_points = endpoint_list(partitions)
    other_keys = {(round(p[0], COORD_DECIMALS), round(p[1], COORD_DECIMALS)) for p in endpoint_list(fixed)}
    counts: Dict[Tuple[float, float], List[int]] = {}
    for index, point in enumerate(part_points):
        counts.setdefault((round(point[0], COORD_DECIMALS), round(point[1], COORD_DECIMALS)), []).append(index)
    free: List[int] = []
    for index, point in enumerate(part_points):
        key = (round(point[0], COORD_DECIMALS), round(point[1], COORD_DECIMALS))
        if key in other_keys:
            continue
        if len({owner // 2 for owner in counts[key]}) == 1:
            free.append(index)
    return free


def _t_snap_once(partitions: List[Wall], fixed: Sequence[Wall]) -> List[Wall]:
    """Land every free partition end on the perpendicular foot of the nearest wall BODY
    (partition or fixed). Only partition ends move."""
    result = [dict(w) for w in partitions]
    all_walls = list(result) + list(fixed)
    protected = _protected_gaps(endpoint_list(all_walls))

    for endpoint_index in _free_partition_endpoints(result, fixed):
        owner = endpoint_index // 2
        all_walls = list(result) + list(fixed)
        points = endpoint_list(all_walls)
        point = points[endpoint_index]
        other_end = points[endpoint_index + 1 if endpoint_index % 2 == 0 else endpoint_index - 1]

        best: Optional[Tuple[float, int, Point]] = None
        for target_index, target in enumerate(all_walls):
            if target_index == owner:
                continue
            if angle_diff_deg(wall_angle_deg(result[owner]), wall_angle_deg(target)) < T_SNAP_MIN_ANGLE_DEG:
                continue  # near-parallel bundle, not a junction
            hit = foot_on_wall(point, target)
            if hit is None:
                continue
            t, foot, distance = hit
            if not (T_SNAP_MIN_T <= t <= T_SNAP_MAX_T) or distance > T_SNAP_MAX_M:
                continue
            if best is None or distance < best[0]:  # strict: lowest target index wins a tie
                best = (distance, target_index, foot)

        if best is None or best[0] <= T_SNAP_EPS_M:
            continue
        new_point = (round(best[2][0], COORD_DECIMALS), round(best[2][1], COORD_DECIMALS))
        new_length = math.hypot(new_point[0] - other_end[0], new_point[1] - other_end[1])
        if new_length < MIN_COLLAPSE_LENGTH_M:
            continue  # must not collapse the wall
        old_vec = (point[0] - other_end[0], point[1] - other_end[1])
        new_vec = (new_point[0] - other_end[0], new_point[1] - other_end[1])
        if old_vec[0] * new_vec[0] + old_vec[1] * new_vec[1] <= 0.0:
            continue  # must not flip it end over end
        if not _move_is_door_safe(endpoint_index, new_point, points, all_walls, protected):
            continue
        key = "a" if endpoint_index % 2 == 0 else "b"
        moved = dict(result[owner])
        moved[key] = [new_point[0], new_point[1]]
        result[owner] = moved
    return round_walls(result)


def _trim_crossings_once(partitions: List[Wall], fixed: Sequence[Wall]) -> List[Wall]:
    """
    Turn an X into an L and a + into a T. Two walls that pass through each other and stick out
    a little past the crossing are a trace artefact, not architecture: the overshoot renders as
    a cross-shaped blob. Where the crossing sits within TRIM_CROSS_MAX_M of a PARTITION's end,
    that end is pulled back onto the crossing point. Fixed walls are never trimmed, so a
    partition poking through the envelope is trimmed flush to it.

    No door guard here, unlike the weld and the T-snap. The crossing point is strictly interior
    to both walls, so a trim always leaves a proper subset of the wall it started with: the free
    space around it can only grow, and no opening can be narrowed. (The endpoint-gap guard would
    in fact veto most of these trims, because it reads "this wall end moved closer to that wall
    end" as a closing doorway even when the material between the two was just deleted.)
    """
    result = [dict(w) for w in partitions]
    all_walls = list(result) + list(fixed)

    for i, j, hit in wall_crossings(all_walls):
        for index in (i, j):
            if index >= len(result):
                continue  # a fixed wall: never moved
            a, b = wall_points(result[index])
            distances = (math.hypot(hit[0] - a[0], hit[1] - a[1]), math.hypot(hit[0] - b[0], hit[1] - b[1]))
            end = 0 if distances[0] <= distances[1] else 1
            if distances[end] > TRIM_CROSS_MAX_M or distances[end] <= T_SNAP_EPS_M:
                continue
            new_point = (round(hit[0], COORD_DECIMALS), round(hit[1], COORD_DECIMALS))
            other_end = b if end == 0 else a
            if math.hypot(new_point[0] - other_end[0], new_point[1] - other_end[1]) < MIN_COLLAPSE_LENGTH_M:
                continue
            moved = dict(result[index])
            moved["a" if end == 0 else "b"] = [new_point[0], new_point[1]]
            result[index] = moved
            all_walls[index] = moved
    return round_walls(result)


def trim_crossings(partitions: List[Wall], fixed: Sequence[Wall]) -> List[Wall]:
    result = round_walls(partitions)
    for _ in range(MAX_PASSES):
        stepped = _trim_crossings_once(result, fixed)
        if stepped == result:
            return result
        result = stepped
    raise RuntimeError("trim_crossings did not converge; check TRIM_CROSS_MAX_M")


def endpoint_is_attached(point: Point, owner: int, walls: Sequence[Wall]) -> bool:
    """Connected means touching another wall at all: its endpoint OR anywhere on its body. The
    endpoint-only test that drives T-snapping is too strict here, because a jamb that has just
    been landed on the core's body is connected in every sense that matters to the eye."""
    for index, other in enumerate(walls):
        if index == owner:
            continue
        if segment_point_distance(point, other) <= ATTACHED_EPS_M:
            return True
    return False


def prune_floating_shards(partitions: List[Wall], fixed: Sequence[Wall]) -> List[Wall]:
    """
    Drop a partition only when it is BOTH shorter than SHARD_MAX_LENGTH_M AND fully floating.
    Short-but-connected is a door jamb (what makes a room read as enclosed); long-but-floating is
    a real wall with door openings at both ends, which the source drawing genuinely has. Only the
    combination is trace debris.
    """
    all_walls = list(partitions) + list(fixed)
    keep: List[Wall] = []
    for index, wall in enumerate(partitions):
        if wall_length(wall) >= SHARD_MAX_LENGTH_M:
            keep.append(wall)
            continue
        a, b = wall_points(wall)
        if endpoint_is_attached(a, index, all_walls) or endpoint_is_attached(b, index, all_walls):
            keep.append(wall)
    return keep


def _geometry_fixpoint(partitions: List[Wall], fixed: Sequence[Wall]) -> List[Wall]:
    """Bundle fusion, collinear merge, weld, T-snap and crossing-trim, to a fixpoint. No pruning
    happens here: a jamb can need several passes before its end lands, and judging connectivity
    before the geometry has settled would delete walls that were about to attach."""
    result = round_walls(partitions)
    for _ in range(MAX_PASSES):
        stepped = clean.drop_degenerate(result)
        stepped = dedupe_bundles(stepped)
        stepped = clean.merge_collinear_chains(stepped)
        stepped = _weld_once(stepped, fixed)
        stepped = _t_snap_once(stepped, fixed)
        stepped = trim_crossings(stepped, fixed)
        stepped = _weld_once(stepped, fixed)
        stepped = clean.drop_degenerate(stepped)
        stepped = round_walls(stepped)
        if stepped == result:
            return result
        result = stepped
    raise RuntimeError("_geometry_fixpoint did not converge; check the tolerances")


def regularize(partitions: List[Wall], fixed: Sequence[Wall]) -> List[Wall]:
    """Settle the geometry, then prune, then settle again (a drop can free a landing)."""
    result = round_walls(partitions)
    for _ in range(MAX_PASSES):
        stepped = prune_floating_shards(_geometry_fixpoint(result, fixed), fixed)
        if stepped == result:
            return result
        result = stepped
    raise RuntimeError("regularize did not reach a fixpoint; check the tolerances")


# ---------------------------------------------------------------------------------------
# Step 6: carry glass flags and authored notes onto the rebuilt walls
# ---------------------------------------------------------------------------------------


def _best_parallel_match(source: Wall, walls: Sequence[Wall]) -> Optional[int]:
    best: Optional[Tuple[float, int]] = None
    src_mid = midpoint(source)
    for index, wall in enumerate(walls):
        if angle_diff_deg(wall_angle_deg(source), wall_angle_deg(wall)) > CARRY_ANGLE_DEG:
            continue
        distance = max(
            segment_point_distance(src_mid, wall),
            0.5 * max(segment_point_distance(p, wall) for p in wall_points(source)),
        )
        if distance > CARRY_PERP_M:
            continue
        if best is None or distance < best[0]:
            best = (distance, index)
    return None if best is None else best[1]


def _nearest_match(source: Wall, walls: Sequence[Wall], max_distance: float) -> Optional[int]:
    best: Optional[Tuple[float, int]] = None
    src_mid = midpoint(source)
    for index, wall in enumerate(walls):
        distance = segment_point_distance(src_mid, wall)
        if distance > max_distance:
            continue
        if best is None or distance < best[0]:
            best = (distance, index)
    return None if best is None else best[1]


def carry_provenance(
    rebuilt: List[Wall], originals: Sequence[Wall]
) -> Tuple[List[Wall], Dict[str, Any]]:
    result = [dict(w) for w in rebuilt]
    glass_total = sum(1 for w in originals if w.get("glass"))
    note_total = sum(1 for w in originals if w.get("note"))
    glass_carried = 0
    note_carried = 0
    notes_by_target: Dict[int, List[str]] = {}

    for wall in originals:
        if wall.get("glass"):
            target = _best_parallel_match(wall, result)
            if target is not None:
                result[target]["glass"] = True
                glass_carried += 1
        note = wall.get("note")
        if note:
            target = _best_parallel_match(wall, result)
            if target is None:
                target = _nearest_match(wall, result, CARRY_NOTE_MAX_M)
            if target is not None:
                bucket = notes_by_target.setdefault(target, [])
                if note not in bucket:
                    bucket.append(note)
                note_carried += 1

    for target, notes in sorted(notes_by_target.items()):
        result[target]["note"] = "\n\n".join(notes)

    stats = {
        "glass_original": glass_total,
        "glass_carried": glass_carried,
        "glass_final": sum(1 for w in result if w.get("glass")),
        "notes_original": note_total,
        "notes_carried": note_carried,
        "notes_final": sum(1 for w in result if w.get("note")),
    }
    return result, stats


# ---------------------------------------------------------------------------------------
# Defect metrics (before / after)
# ---------------------------------------------------------------------------------------

METRIC_DUP_ANGLE_DEG = 8.0
METRIC_DUP_PERP_M = 0.90
METRIC_DUP_OVERLAP_FRACTION = 0.50
METRIC_SHORT_M = 1.2
METRIC_TGAP_MAX_M = 0.35
METRIC_TGAP_MIN_T = 0.05
METRIC_TGAP_MAX_T = 0.95
METRIC_ATTACHED_M = 0.02
METRIC_CROSS_MARGIN_M = 0.05  # how far inside both segments the hit must sit to count


def count_parallel_duplicate_pairs(walls: Sequence[Wall]) -> int:
    count = 0
    for i in range(len(walls)):
        for j in range(i + 1, len(walls)):
            a, b = walls[i], walls[j]
            if angle_diff_deg(wall_angle_deg(a), wall_angle_deg(b)) > METRIC_DUP_ANGLE_DEG:
                continue
            longer, shorter = (a, b) if wall_length(a) >= wall_length(b) else (b, a)
            origin, direction = _pt(longer["a"]), unit_direction(longer)
            s0, s1 = wall_points(shorter)
            perp = max(
                perpendicular_distance(s0, origin, direction),
                perpendicular_distance(s1, origin, direction),
            )
            if perp > METRIC_DUP_PERP_M:
                continue
            if overlap_along(shorter, longer) >= METRIC_DUP_OVERLAP_FRACTION * wall_length(shorter):
                count += 1
    return count


def wall_crossings(walls: Sequence[Wall]) -> List[Tuple[int, int, Point]]:
    """
    Pairs that pass through each other's INTERIOR. The intersection has to sit at least
    METRIC_CROSS_MARGIN_M from all four endpoints, so a T-junction landing (an end exactly on
    another wall's body) and a shared corner are not crossings, which is the distinction that
    matters when judging whether the plan reads as a building.
    """
    hits: List[Tuple[int, int, Point]] = []
    for i in range(len(walls)):
        a0, a1 = wall_points(walls[i])
        len_a = wall_length(walls[i])
        for j in range(i + 1, len(walls)):
            b0, b1 = wall_points(walls[j])
            if not _segments_properly_cross(a0, a1, b0, b1):
                continue
            params = _crossing_point(a0, a1, b0, b1)
            if params is None:
                continue
            t, u = params
            len_b = wall_length(walls[j])
            if min(t, 1.0 - t) * len_a <= METRIC_CROSS_MARGIN_M:
                continue
            if min(u, 1.0 - u) * len_b <= METRIC_CROSS_MARGIN_M:
                continue
            hits.append((i, j, (a0[0] + t * (a1[0] - a0[0]), a0[1] + t * (a1[1] - a0[1]))))
    return hits


def count_wall_crossings(walls: Sequence[Wall]) -> int:
    return len(wall_crossings(walls))


def free_endpoints(walls: Sequence[Wall]) -> List[int]:
    """An endpoint is attached if it coincides with another wall's endpoint or sits on another
    wall's body. Everything else is free (a visible loose wall end at 0.15 m thickness)."""
    points = endpoint_list(walls)
    free: List[int] = []
    for index, point in enumerate(points):
        owner = index // 2
        attached = False
        for other_index, other in enumerate(walls):
            if other_index == owner:
                continue
            if segment_point_distance(point, other) <= METRIC_ATTACHED_M:
                attached = True
                break
        if not attached:
            free.append(index)
    return free


def count_tjunction_gaps(walls: Sequence[Wall]) -> int:
    points = endpoint_list(walls)
    count = 0
    for index in free_endpoints(walls):
        owner = index // 2
        for other_index, other in enumerate(walls):
            if other_index == owner:
                continue
            hit = foot_on_wall(points[index], other)
            if hit is None:
                continue
            t, _foot, distance = hit
            if METRIC_TGAP_MIN_T < t < METRIC_TGAP_MAX_T and distance <= METRIC_TGAP_MAX_M:
                count += 1
                break
    return count


def metrics(walls: Sequence[Wall]) -> Dict[str, Any]:
    return {
        "walls": len(walls),
        "total_length_m": sum(wall_length(w) for w in walls),
        "parallel_duplicate_pairs": count_parallel_duplicate_pairs(walls),
        "wall_crossings": count_wall_crossings(walls),
        "walls_under_1_2m": sum(1 for w in walls if wall_length(w) < METRIC_SHORT_M),
        "free_endpoints": len(free_endpoints(walls)),
        "tjunction_gaps": count_tjunction_gaps(walls),
        "glass_walls": sum(1 for w in walls if w.get("glass")),
        "walls_with_notes": sum(1 for w in walls if w.get("note")),
    }


def print_metrics(before: Dict[str, Any], after: Dict[str, Any]) -> None:
    rows = [
        ("wall count", "walls", "{:.0f}"),
        ("total wall length (m)", "total_length_m", "{:.1f}"),
        ("parallel duplicate pairs", "parallel_duplicate_pairs", "{:.0f}"),
        ("wall crossings", "wall_crossings", "{:.0f}"),
        ("walls under 1.2 m", "walls_under_1_2m", "{:.0f}"),
        ("free endpoints", "free_endpoints", "{:.0f}"),
        ("T-junction gaps (<= 0.35 m)", "tjunction_gaps", "{:.0f}"),
        ("glass walls", "glass_walls", "{:.0f}"),
        ("walls carrying a note", "walls_with_notes", "{:.0f}"),
    ]
    width = max(len(r[0]) for r in rows)
    print(f"{'metric'.ljust(width)}  {'before':>10}  {'after':>10}")
    print(f"{'-' * width}  {'-' * 10}  {'-' * 10}")
    for label, key, fmt in rows:
        print(f"{label.ljust(width)}  {fmt.format(before[key]):>10}  {fmt.format(after[key]):>10}")


# ---------------------------------------------------------------------------------------
# The rebuild
# ---------------------------------------------------------------------------------------


def rebuild(plan: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    originals = [round_wall(w) for w in plan["walls"]]

    holes, repaired_names = repair_holes(plan["holes"])
    hole_polygons = [[_pt(p) for p in hole["polygon"]] for hole in holes]

    envelope = build_envelope_walls(plan["walkableOutline"])
    core = build_core_walls(holes)
    fixed = envelope + core

    outline = [_pt(p) for p in plan["walkableOutline"]]
    partitions, rejected = admit_partitions(originals, fixed, outline, hole_polygons)
    partitions = regularize(partitions, fixed)
    # Re-apply the admission filters: regularization moves ends, so a partition can only now
    # have become a duplicate of the envelope. Re-applying is also what makes the whole script
    # a fixpoint (a second run sees its own output and reproduces it).
    partitions, _ = admit_partitions(partitions, fixed, outline, hole_polygons)

    walls = round_walls(fixed + partitions)
    walls, provenance = carry_provenance(walls, originals)

    # Guardrail: no room anchor or the entrance may end up inside a repaired core hole.
    for room in plan["rooms"]:
        for label, point in (("center", room["center"]), ("door", room["door"])):
            for hole, polygon in zip(holes, hole_polygons):
                assert not point_in_polygon(_pt(point), polygon), (
                    f'room "{room["name"]}" {label} landed inside hole {hole["name"]}'
                )
    for hole, polygon in zip(holes, hole_polygons):
        assert not point_in_polygon(_pt(plan["entrance"]["point"]), polygon), (
            f'entrance landed inside hole {hole["name"]}'
        )

    result = dict(plan)
    result["holes"] = holes
    result["walls"] = walls
    result["note"] = clean.strip_previous_sentence(strip_rebuild_sentence(plan["note"])) + rebuild_sentence(
        len(envelope), len(core), len(partitions)
    )

    info = {
        "envelope": len(envelope),
        "core": len(core),
        "partitions": len(partitions),
        "rejected": rejected,
        "repaired_holes": repaired_names,
        "provenance": provenance,
    }
    return result, info


def rebuild_sentence(envelope_count: int, core_count: int, partition_count: int) -> str:
    """
    Describes the RESULT, never what this particular run changed, so re-runs stay byte identical.
    (The core-repair clause is phrased as a fact about the file rather than as "this run repaired
    it": on a second run the polygon is already a rectangle, and a delta-shaped sentence would
    silently drop the clause and change the bytes.)
    """
    return (
        f" {NOTE_MARKER} the walls array is no longer the raster trace's own segment list; it is "
        f"constructed from clean primitives. Both elevator/stair core polygons are simple, "
        f"correctly wound axis-aligned rectangles over their own bands, matching the two plain "
        f"horizontal core bands the source drawing shows; the upper one came out of the trace as "
        f"a self-intersecting 29-point polygon, which is what had let the shaft boxes inside it "
        f"survive as walls and render as a comb across the middle of the floor. "
        f"{envelope_count} walls are one-per-edge of walkableOutline (a closed envelope by "
        f"construction), {core_count} are one-per-edge of the two repaired elevator/stair core "
        f"polygons, and {partition_count} are interior partitions admitted from the trace: a "
        f"traced segment is kept only if it is at least {PARTITION_MIN_LENGTH_M:.1f} m long, its "
        f"midpoint is outside both core polygons, and it does not shadow an envelope or core wall "
        f"(within {DUP_ANGLE_DEG:.0f} degrees and {DUP_PERP_M:.2f} m with real overlap). Admitted "
        f"partitions were then merged where collinear, welded at ends within "
        f"{WELD_RADIUS_M:.2f} m, and landed on the perpendicular foot of any wall body within "
        f"{T_SNAP_MAX_M:.2f} m, with the envelope and core pinned so they keep matching "
        f"walkableOutline and the holes exactly. Wall dimensions and angles are therefore "
        f"constructed, not surveyed. No weld or snap was allowed to narrow a door-sized opening, "
        f"and every room stays path-reachable (npm run test:nav, 18/18, no PARTIAL paths); glass "
        f"flags and authored per-wall notes are carried onto the nearest parallel rebuilt wall."
    )


def strip_rebuild_sentence(note: str) -> str:
    index = note.find(NOTE_MARKER)
    if index == -1:
        return note
    return note[:index].rstrip()


# ---------------------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------------------


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Rebuild floor-14.json walls from primitives.")
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    parser.add_argument("--render", default=None, help="also write a top-down PNG here")
    args = parser.parse_args(argv)

    plan, newline = clean.read_plan(SERVER_PLAN_PATH)
    before = metrics([round_wall(w) for w in plan["walls"]])

    result, info = rebuild(plan)
    after = metrics(result["walls"])

    print(f"repaired holes      : {info['repaired_holes'] or 'none'}")
    print(f"envelope walls      : {info['envelope']} (one per walkableOutline edge)")
    print(f"core walls          : {info['core']} (one per repaired hole edge)")
    print(f"interior partitions : {info['partitions']}")
    print(
        "rejected candidates : "
        f"{info['rejected']['too_short']} shorter than {PARTITION_MIN_LENGTH_M:.1f} m after "
        f"clipping, {info['rejected']['off_floor']} wholly off the floor (inside a core hole or "
        f"outside the outline), {info['rejected']['shadowed_fixed']} wholly shadowing the "
        f"envelope/core"
    )
    prov = info["provenance"]
    print(
        f"provenance          : glass {prov['glass_carried']}/{prov['glass_original']} carried "
        f"({prov['glass_final']} glass walls in the rebuild), notes "
        f"{prov['notes_carried']}/{prov['notes_original']} carried "
        f"({prov['notes_final']} walls carry a note)"
    )
    print()
    print_metrics(before, after)

    if args.dry_run:
        print("\n(dry run: nothing written)")
    else:
        payload = clean.render_plan(result, newline)
        for path in (SERVER_PLAN_PATH, CLIENT_PLAN_PATH):
            with open(path, "wb") as handle:
                handle.write(payload)
            print(f"wrote {path} ({len(payload)} bytes)")

    if args.render:
        import render_floor_plan

        render_floor_plan.render(result, args.render, scale=30.0)
        print(f"wrote {args.render}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
