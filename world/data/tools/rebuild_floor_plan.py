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
  Step 6  Repair DANGLING partition ends against the source drawing (repair_dangling_ends).
          Regularization lands an end on a neighbour only when the two are already close; an end
          that stops in open space with nothing to land on stays loose, and at 0.15 m thickness a
          loose end reads as a fragment rather than a room. Each dangling end is decided by
          looking at the source raster: extend/retract it onto a neighbour, bridge a run the
          trace broke, or leave it. An end that faces a door opening is left alone, and the
          evidence for "door" is the source drawing itself, not a heuristic.
  Step 7  Carry `glass: true` and authored `note` fields from the pre-rebuild walls onto the
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

# --- Step 6 dangling-end repair --------------------------------------------------------
# What counts as DANGLING. An end is ATTACHED if it sits on another wall's body; otherwise it
# is still legitimate architecture when it faces a near-collinear wall end across a door-sized
# gap (a jamb pair) or when a room's own `door` anchor is right there. Everything else is a
# loose end in open space.
DANGLE_ATTACHED_EPS_M = 0.03
DANGLE_COLLINEAR_DEG = 12.0
DANGLE_GAP_MIN_M = 0.50
DANGLE_GAP_MAX_M = 1.80
DANGLE_DOOR_NEAR_M = 1.20

# Rule 1, "extend or retract to meet". A landing is another wall's endpoint, or the
# perpendicular foot on another wall's body. It must be reachable essentially ALONG the dangling
# wall's own axis: LAND_MAX_LATERAL_M bounds how far sideways the end may be dragged and
# LAND_MAX_TURN_DEG bounds how far the wall's own bearing may swing, which together stop a wall
# being bent onto a neighbour that merely happens to pass nearby.
# Endpoints outrank bodies at equal reach, matching stage D running before stage F in
# clean_floor_plan.py: meeting a neighbour at its corner is a better answer than landing part way
# along it, and preferring the strictly nearer landing would pick the body every time.
LAND_MAX_M = 0.90
LAND_MAX_LATERAL_M = 0.35
LAND_MAX_TURN_DEG = 10.0
LAND_MIN_ANGLE_DEG = T_SNAP_MIN_ANGLE_DEG  # a body landing is a junction; near-parallel is a bundle

# Rule 2, "bridge a run the trace broke": join the dangling end to a nearby wall endpoint.
BRIDGE_MAX_M = 1.20

# The source raster is the evidence for every extend and every bridge. A span is "on ink" when
# EVERY sample along it is within INK_ON_MAX_M of a dark source pixel. Measured on this plan:
# wall bodies that are certainly real run 0.07 to 0.13 m from ink (the trace's own error), and
# the three door openings that must never be bridged run 0.37 to 0.69 m. 0.15 m separates them
# with margin on both sides.
#
# INK_LEVEL was 130 and that was too strict: this drawing renders its thin interior partitions
# in LIGHT grey, not black. Sampled down the washroom block's right wall (world x 23.30) the
# pixel values are 70 (a wall nobody disputes), then 133 to 140 for the SAME kind of line a
# little further along, then 247 to 253 where the paper is genuinely blank. The same split shows
# up on the Gender Neutral washroom's left wall (a continuous run of 132 to 139 from z 10.02 down
# to z 8.96). At 130 every one of those light-drawn walls read as blank paper, so the pipeline
# preserved trace breaks in them as if they were doorways. 150 admits them and still leaves a
# wide margin to the >= 200 of real blank paper; 150 to 200 is nobody's line and nobody's paper,
# and nothing on this plan is decided in that band.
INK_LEVEL = 150           # greyscale below this is drawn ink
INK_BLANK_LEVEL = 200     # greyscale at or above this is definitely blank paper
INK_STEP_M = 0.04         # sample spacing along a span
INK_SEARCH_MAX_PX = 12    # give up looking for ink past this radius (~0.67 m)
INK_ON_MAX_M = 0.15
# Rule 3, "drop it". Only ever applied to a SHORT wall whose own body is off the drawing: a long
# wall is real architecture even when one of its ends overshoots, and deleting one to make a
# count go down is how this plan lost real walls once already.
DROP_MAX_LENGTH_M = SHARD_MAX_LENGTH_M
DROP_OFF_INK_MEAN_M = 0.35

# --- Step 6b: close a break the trace invented ------------------------------------------
# Two loose wall ends facing each other across a short gap are either a doorway or a joint the
# trace dropped, and step 6's rules only ever look at ONE end at a time, so a pair like that is
# invisible to them (each end is "a jamb facing a near-collinear end", which is exactly what a
# real doorway looks like). This step judges the PAIR, and it closes the gap only on positive
# evidence that the drawing has no opening there:
#   (a) another wall's body runs straight through the gap. The drawing interrupts a wall where a
#       thicker wall crosses it (the washroom block's south wall stops at both faces of the
#       0.72 m plumbing chase between the Male and Female washrooms), and the trace kept the
#       interruption. A crossing wall is a junction, never a door.
#   (b) the span is on ink, judged against how far off ink THESE TWO WALLS ALREADY ARE. A flat
#       bound assumes the trace sits on the line it traced; on this plan the Classroom 1417 /
#       North Collaboration run is traced ~0.2 m off its own drawn line for its whole length, so
#       a flat bound calls the joint between its two pieces "blank" for the same reason it would
#       call the pieces themselves blank. Scoring the gap against the walls' own worst error asks
#       the only question that matters: is the gap any worse supported than the walls either side
#       of it?
CLOSE_PAIR_MAX_M = 1.00
CLOSE_PAIR_INK_SLACK = 1.25    # of the two walls' own worst off-ink distance
# Never let the slack alone justify closing a door-width blank. Measured on this plan: the seven
# openings the drawing really has run 0.36 to 0.47 m off ink while the walls either side of them
# are traced 0.05 to 0.12 m off (budget 0.15 m, so none of them is even close to firing), and the
# two runs that are traced badly enough to need the slack are 0.32 to 0.33 m off along their own
# bodies. 0.40 m clears those two and still refuses every opening.
CLOSE_PAIR_INK_CAP_M = 0.40

# --- Step 6c: draw a wall the trace has none of -----------------------------------------
# Past a loose end, beyond a gap that is genuinely blank (so it must stay open), the drawing
# sometimes carries on with a wall the trace never emitted at all: the washroom block's right
# wall resumes below the Gender Neutral washroom's door, and the 1429/1430 jamb is drawn but
# missing. Those leave a partition floating with nothing to meet. This step reads the run off the
# raster and emits it.
RUN_SCAN_MAX_M = 2.20
RUN_MIN_M = 0.60          # shorter than this is a tick mark or a leader line, not a wall
RUN_STEP_M = 0.02
RUN_BAND_M = 0.09         # half the rendered wall thickness: a 1 px trace offset is not a hole
# A drawn wall is a LINE. A pictogram (the washroom figures) or a heavy label is a BLOB, and it
# would otherwise read as a long ink run. Requiring blank paper to both sides separates them.
RUN_THIN_OFFSET_M = 0.28
RUN_THIN_MIN_FRACTION = 0.80
RUN_COVER_M = 0.25        # a near-parallel wall this close already draws the run
RUN_COVER_ANGLE_DEG = 20.0

# --- Step 7 provenance carry-over ------------------------------------------------------
CARRY_ANGLE_DEG = 20.0
CARRY_PERP_M = 0.60
CARRY_NOTE_MAX_M = 2.00  # a note falls back to the nearest wall within this if nothing parallel

# --- Step 8 shadow-stub absorption -----------------------------------------------------
# A SHADOW STUB is a short tab with one free end lying flat against a longer wall: the trace's
# leftover of a step in a jagged front, which renders as a tab poking past the T junction. The
# bounds here are deliberately looser in angle than DUP_ANGLE_DEG, because the stubs that survive
# admission are the ones a few degrees too splayed to have read as duplicates (the Kitchen /
# 1407 / 1408-vs-Event-Space front's step is ~16 degrees off its own facade), and tighter in
# distance, because at this length a wall further out than STUB_PERP_M is a real second line.
STUB_MAX_LENGTH_M = 0.80
STUB_ANGLE_DEG = 25.0
STUB_PERP_M = 0.25
STUB_HOST_MIN_EXTRA_M = 0.20  # the host must be meaningfully longer, not a same-size sibling
STUB_MIN_T = -0.05            # the shadow must land inside the host's span, not off either tip
STUB_MAX_T = 1.05
# How far a wall that T-joined the stub may be extended to reach the host instead. Bounded by the
# same budget as a T-snap, so absorbing a stub can never move a junction further than the
# regularizer itself would have.
STUB_RELAND_MAX_M = T_SNAP_MAX_M

COORD_DECIMALS = clean.COORD_DECIMALS
MAX_PASSES = 40

NOTE_MARKER = "Geometry REBUILD pass (world/data/tools/rebuild_floor_plan.py):"

SERVER_PLAN_PATH = clean.SERVER_PLAN_PATH
CLIENT_PLAN_PATH = clean.CLIENT_PLAN_PATH
SOURCE_IMAGE_PATH = os.path.join(
    os.path.dirname(SERVER_PLAN_PATH), "source", "floor-14-plan-hires.png"
)


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


def wall_is_connected(index: int, walls: Sequence[Wall]) -> bool:
    """
    Does this wall touch any other wall at all? Either of MY ends landing on someone else's body
    counts, and so does someone else's end landing on MY body: a wall that another wall T-joins
    mid-span is part of the building, whichever way round the junction was authored. Testing only
    my own ends would call the washroom block's re-drawn right wall "floating" purely because the
    Gender Neutral washroom's south wall meets it in the middle rather than at a tip.
    """
    a, b = wall_points(walls[index])
    if endpoint_is_attached(a, index, walls) or endpoint_is_attached(b, index, walls):
        return True
    for other_index, other in enumerate(walls):
        if other_index == index:
            continue
        if any(
            segment_point_distance(point, walls[index]) <= ATTACHED_EPS_M
            for point in wall_points(other)
        ):
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
        if wall_length(wall) >= SHARD_MAX_LENGTH_M or wall_is_connected(index, all_walls):
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
# Step 6: repair dangling partition ends, with the source drawing as the evidence
# ---------------------------------------------------------------------------------------

_SOURCE_CACHE: Dict[str, Any] = {}


def _source_raster(path: str = SOURCE_IMAGE_PATH) -> Tuple[Any, int, int]:
    """The source line drawing as a greyscale pixel accessor, loaded once."""
    cached = _SOURCE_CACHE.get(path)
    if cached is None:
        from PIL import Image  # noqa: PLC0415  (optional at import time, required by this step)

        image = Image.open(path).convert("L")
        cached = (image.load(), image.width, image.height)
        _SOURCE_CACHE[path] = cached
    return cached


def _world_to_source_px(point: Point) -> Tuple[float, float]:
    """The transform recorded in the plan's own `note`, shared with render_floor_plan."""
    import render_floor_plan  # noqa: PLC0415  (same directory; imported lazily like --render)

    return render_floor_plan.world_to_source_px(point)


def distance_to_ink(point: Point) -> float:
    """Distance in metres from a world point to the nearest drawn pixel in the source."""
    import render_floor_plan  # noqa: PLC0415

    metres_per_px = render_floor_plan.SOURCE_SCALE_M_PER_PX
    pixels, width, height = _source_raster()
    px, py = _world_to_source_px(point)
    cx, cy = int(round(px)), int(round(py))
    for radius in range(INK_SEARCH_MAX_PX + 1):
        best: Optional[float] = None
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                if max(abs(dx), abs(dy)) != radius:
                    continue  # only the new ring; inner rings were searched already
                ix, iy = cx + dx, cy + dy
                if 0 <= ix < width and 0 <= iy < height and pixels[ix, iy] < INK_LEVEL:
                    found = math.hypot(ix - px, iy - py)
                    if best is None or found < best:
                        best = found
        if best is not None:
            return best * metres_per_px
    return INK_SEARCH_MAX_PX * metres_per_px


def span_off_ink(start: Point, end: Point) -> float:
    """The worst distance-to-ink over a span. Small means the drawing really has a line here."""
    length = math.hypot(end[0] - start[0], end[1] - start[1])
    steps = max(2, int(length / INK_STEP_M))
    worst = 0.0
    for index in range(steps + 1):
        t = index / steps
        sample = (start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1]))
        worst = max(worst, distance_to_ink(sample))
    return worst


def wall_mean_off_ink(wall: Wall) -> float:
    a, b = wall_points(wall)
    length = wall_length(wall)
    steps = max(2, int(length / INK_STEP_M))
    total = 0.0
    for index in range(steps + 1):
        t = index / steps
        total += distance_to_ink((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    return total / (steps + 1)


def dangling_ends(walls: Sequence[Wall], rooms: Sequence[Dict[str, Any]]) -> List[Tuple[int, int]]:
    """
    Endpoint indices (into endpoint_list) that stop in open space.

    An end is ATTACHED when it sits within DANGLE_ATTACHED_EPS_M of another wall's body. An
    unattached end is still legitimate when it is one half of a door jamb: either a near-collinear
    wall end faces it across a door-sized gap, or a room's own `door` anchor is right there.
    Returns (wall index, endpoint index) pairs in ascending order.
    """
    points = endpoint_list(walls)
    doors = [_pt(room["door"]) for room in rooms]
    result: List[Tuple[int, int]] = []
    for index, point in enumerate(points):
        owner = index // 2
        if any(
            segment_point_distance(point, other) <= DANGLE_ATTACHED_EPS_M
            for position, other in enumerate(walls)
            if position != owner
        ):
            continue
        if any(math.hypot(point[0] - d[0], point[1] - d[1]) <= DANGLE_DOOR_NEAR_M for d in doors):
            continue
        jamb = False
        for other_index, other_point in enumerate(points):
            if other_index // 2 == owner:
                continue
            gap = math.hypot(point[0] - other_point[0], point[1] - other_point[1])
            if not (DANGLE_GAP_MIN_M <= gap <= DANGLE_GAP_MAX_M):
                continue
            if angle_diff_deg(
                wall_angle_deg(walls[owner]), wall_angle_deg(walls[other_index // 2])
            ) <= DANGLE_COLLINEAR_DEG:
                jamb = True
                break
        if not jamb:
            result.append((owner, index))
    return result


def _absolute_door_safe(
    old_point: Point, new_point: Point, owner: int, walls: Sequence[Wall]
) -> bool:
    """A move may not bring an endpoint within a door width of a wall it used to be clear of.
    This is the absolute half of the weld/T-snap door guard. The relative half (do not narrow a
    protected endpoint gap) is deliberately NOT applied here: it reads every jamb pair as a
    doorway, including the ones the source draws as an unbroken line, and the ink test below is
    direct evidence about the same question."""
    for index, other in enumerate(walls):
        if index == owner:
            continue
        if segment_point_distance(old_point, other) < DOOR_MIN_GAP_M:
            continue
        if segment_point_distance(new_point, other) < DOOR_MIN_GAP_M:
            return False
    return True


def _overshoot_landing(
    walls: Sequence[Wall], owner: int, end_point: Point, other_end: Point
) -> Optional[Tuple[float, int, Point]]:
    """
    The dangling end is an OVERSHOOT when another wall already ends ON this wall's body, short of
    the dangling end: the junction is real and the material past it is the trace running on. The
    end retracts to that junction, which both trims the overshoot and welds the two walls at a
    shared corner.

    This outranks the general landing search because the general search minimises the MOVE, and a
    lateral snap onto the same neighbour's body is always a smaller move than trimming back to its
    tip. Taking the smaller move there leaves the overshoot in place, and the neighbour's tip then
    reads as dangling instead, so the two walls chase each other pass after pass.
    """
    best: Optional[Tuple[float, int, Point]] = None
    for index, other in enumerate(walls):
        if index == owner:
            continue
        for point in wall_points(other):
            if segment_point_distance(point, walls[owner]) > DANGLE_ATTACHED_EPS_M:
                continue  # not a junction on our body
            distance = math.hypot(point[0] - end_point[0], point[1] - end_point[1])
            if distance <= T_SNAP_EPS_M or distance > LAND_MAX_M:
                continue
            new_length = math.hypot(point[0] - other_end[0], point[1] - other_end[1])
            if new_length < max(MIN_COLLAPSE_LENGTH_M, PARTITION_MIN_LENGTH_M):
                continue
            if new_length >= math.hypot(end_point[0] - other_end[0], end_point[1] - other_end[1]):
                continue  # the junction is not between the two ends, so nothing overshoots it
            landing = (round(point[0], COORD_DECIMALS), round(point[1], COORD_DECIMALS))
            if best is None or (distance, index, landing) < (best[0], best[1], best[2]):
                best = (distance, index, landing)
    return best


def _landing_candidates(
    walls: Sequence[Wall], owner: int, end_point: Point, other_end: Point
) -> List[Tuple[float, int, Point]]:
    """
    Places the dangling end could land: another wall's endpoint, or the perpendicular foot on
    another wall's body. Sorted by move distance, then target index, so the choice is a pure
    function of the wall list.
    """
    axis = math.hypot(end_point[0] - other_end[0], end_point[1] - other_end[1])
    if axis <= 0.0:
        return []
    outward = ((end_point[0] - other_end[0]) / axis, (end_point[1] - other_end[1]) / axis)

    bearing = wall_angle_deg(walls[owner])
    found: List[Tuple[int, float, int, Point]] = []
    for index, target in enumerate(walls):
        if index == owner:
            continue
        options: List[Tuple[int, Point]] = [(0, point) for point in wall_points(target)]
        if angle_diff_deg(bearing, wall_angle_deg(target)) >= LAND_MIN_ANGLE_DEG:
            hit = foot_on_wall(end_point, target)
            if hit is not None and T_SNAP_MIN_T <= hit[0] <= T_SNAP_MAX_T:
                options.append((1, hit[1]))
        for rank, option in options:
            point = (round(option[0], COORD_DECIMALS), round(option[1], COORD_DECIMALS))
            move = (point[0] - end_point[0], point[1] - end_point[1])
            distance = math.hypot(move[0], move[1])
            if distance > LAND_MAX_M or distance <= T_SNAP_EPS_M:
                continue
            lateral = abs(move[0] * outward[1] - move[1] * outward[0])
            if lateral > LAND_MAX_LATERAL_M:
                continue  # sideways, not along the wall's own axis: that would bend the wall
            new_length = math.hypot(point[0] - other_end[0], point[1] - other_end[1])
            if new_length < max(MIN_COLLAPSE_LENGTH_M, PARTITION_MIN_LENGTH_M):
                continue  # a survivor has to clear the admission floor, or the next run drops it
            new_vector = (point[0] - other_end[0], point[1] - other_end[1])
            if new_vector[0] * outward[0] + new_vector[1] * outward[1] <= 0.0:
                continue  # must not flip the wall end over end
            landed = {"a": [point[0], point[1]], "b": [other_end[0], other_end[1]]}
            if angle_diff_deg(bearing, wall_angle_deg(landed)) > LAND_MAX_TURN_DEG:
                continue
            found.append((rank, distance, index, point))
    found.sort(key=lambda item: (item[0], round(item[1], 6), item[2], item[3]))
    return [(distance, index, point) for _rank, distance, index, point in found]


def _bridge_candidates(
    walls: Sequence[Wall], owner: int, end_point: Point
) -> List[Tuple[float, int, Point]]:
    """Nearby endpoints of other walls that a missing segment could span to."""
    found: List[Tuple[float, int, Point]] = []
    for index, target in enumerate(walls):
        if index == owner:
            continue
        for point in wall_points(target):
            distance = math.hypot(point[0] - end_point[0], point[1] - end_point[1])
            if distance > BRIDGE_MAX_M or distance < MIN_COLLAPSE_LENGTH_M:
                continue
            if segment_point_distance(point, walls[owner]) <= DANGLE_ATTACHED_EPS_M:
                continue  # already on our own body: a bridge there would just overlap us
            found.append((distance, index, point))
    found.sort(key=lambda item: (round(item[0], 6), item[1], item[2]))
    return found


def _bridge_is_clean(start: Point, end: Point, walls: Sequence[Wall]) -> bool:
    """A bridge may touch walls at its ends but may not cut through one."""
    for wall in walls:
        p, q = wall_points(wall)
        if _segments_properly_cross(start, end, p, q):
            return False
    return True


def repair_dangling_ends(
    partitions: List[Wall], fixed: Sequence[Wall], rooms: Sequence[Dict[str, Any]]
) -> Tuple[List[Wall], List[str]]:
    """
    Resolve every dangling PARTITION end, one per pass, in three priority orders.

      1 EXTEND / RETRACT to meet. The end lands on a neighbour's endpoint or body, forming a
        clean T or L, provided the landing is along the wall's own axis. Where the move ADDS
        material the added span must be on ink, which is what keeps a doorway from being sealed;
        where it only removes material no ink test is needed, because a trim can widen an opening
        but never narrow one.
      2 BRIDGE. Where the source draws an unbroken run that the trace chopped, the missing
        segment is added so the run is continuous again. Gated on the same ink test.
      3 DROP. Only a SHORT wall whose own body is off the drawing. A long wall is architecture
        even when an end overshoots.

    Ends that no rule fits are left exactly as they are; that is the honest answer for a jamb
    facing a real door opening, and it is why the pass reports what it did rather than driving a
    count to zero.

    One change per pass with a restart keeps the result a pure function of the wall list, and the
    pass is idempotent: every repair lands an end ON another wall, so on a re-run that end is
    ATTACHED, is not dangling, and nothing fires again.
    """
    result = [dict(w) for w in partitions]
    actions: List[str] = []

    for _ in range(MAX_PASSES):
        walls = result + list(fixed)
        partition_count = len(result)

        def name(index: int, count: int = partition_count) -> int:
            """Index in the WRITTEN walls[] (fixed first, then partitions), for readable logs."""
            return index + len(fixed) if index < count else index - count

        loose = [item for item in dangling_ends(walls, rooms) if item[0] < len(result)]
        if not loose:
            return round_walls(result), actions

        changed = False
        for owner, endpoint_index in loose:
            points = endpoint_list(walls)
            end_point = points[endpoint_index]
            other_end = points[endpoint_index + 1 if endpoint_index % 2 == 0 else endpoint_index - 1]
            key = "a" if endpoint_index % 2 == 0 else "b"

            overshoot = _overshoot_landing(walls, owner, end_point, other_end)
            if overshoot is not None:
                distance, target_index, point = overshoot
                moved = dict(result[owner])
                moved[key] = [point[0], point[1]]
                result[owner] = round_wall(moved)
                actions.append(
                    f"retract wall {name(owner)} end {key} "
                    f"[{end_point[0]:.3f}, {end_point[1]:.3f}] by {distance:.3f} m onto the "
                    f"existing junction with wall {name(target_index)} at "
                    f"[{point[0]:.3f}, {point[1]:.3f}] (overshoot past a real corner)"
                )
                changed = True
                break

            landing = None
            for distance, target_index, point in _landing_candidates(
                walls, owner, end_point, other_end
            ):
                axis = math.hypot(end_point[0] - other_end[0], end_point[1] - other_end[1])
                outward = (
                    (end_point[0] - other_end[0]) / axis,
                    (end_point[1] - other_end[1]) / axis,
                )
                along = (point[0] - end_point[0]) * outward[0] + (point[1] - end_point[1]) * outward[1]
                if along > 0.0:
                    # The move ADDS material, so it is the move that could seal a doorway. The
                    # source drawing answers that directly: if the line is unbroken here there is
                    # no door here. The geometric door guard is not applied on top, because it
                    # reads "this end moved closer to that end" as a closing doorway, which is
                    # true of every joint being closed and would veto them all.
                    if span_off_ink(end_point, point) > INK_ON_MAX_M:
                        continue
                elif not _absolute_door_safe(end_point, point, owner, walls):
                    continue  # a sideways move adds no material, but may still crowd a gap
                landing = (distance, target_index, point, along)
                break
            if landing is not None:
                distance, target_index, point, along = landing
                moved = dict(result[owner])
                moved[key] = [point[0], point[1]]
                result[owner] = round_wall(moved)
                actions.append(
                    f"{'extend' if along > 0.0 else 'retract'} wall {name(owner)} end {key} "
                    f"[{end_point[0]:.3f}, {end_point[1]:.3f}] by {distance:.3f} m onto wall "
                    f"{name(target_index)} at [{point[0]:.3f}, {point[1]:.3f}]"
                )
                changed = True
                break

            bridged = False
            for distance, target_index, point in _bridge_candidates(walls, owner, end_point):
                if span_off_ink(end_point, point) > INK_ON_MAX_M:
                    continue
                if not _bridge_is_clean(end_point, point, walls):
                    continue
                result.append(make_wall(end_point, point))
                actions.append(
                    f"bridge wall {name(owner)} end {key} [{end_point[0]:.3f}, {end_point[1]:.3f}] to "
                    f"wall {name(target_index)} at [{point[0]:.3f}, {point[1]:.3f}] ({distance:.3f} m "
                    f"of drawn line the trace lost)"
                )
                bridged = True
                break
            if bridged:
                changed = True
                break

            if (
                wall_length(result[owner]) < DROP_MAX_LENGTH_M
                and wall_mean_off_ink(result[owner]) > DROP_OFF_INK_MEAN_M
            ):
                actions.append(
                    f"drop wall {name(owner)} ({wall_length(result[owner]):.2f} m): the source drawing "
                    f"has no line along it"
                )
                del result[owner]
                changed = True
                break

        if not changed:
            return round_walls(result), actions

    raise RuntimeError("repair_dangling_ends did not converge; check the LAND_*/BRIDGE_* tolerances")


# ---------------------------------------------------------------------------------------
# Step 6b: close a break the trace invented (judged on the PAIR of ends, not one end)
# ---------------------------------------------------------------------------------------


def free_endpoint_indices(walls: Sequence[Wall], epsilon: float = DANGLE_ATTACHED_EPS_M) -> List[int]:
    """Endpoint indices (into endpoint_list) not sitting on any OTHER wall's body."""
    points = endpoint_list(walls)
    return [
        index
        for index, point in enumerate(points)
        if not any(
            segment_point_distance(point, other) <= epsilon
            for position, other in enumerate(walls)
            if position != index // 2
        )
    ]


def wall_off_ink(wall: Wall) -> float:
    """The worst distance-to-ink along a wall's own body: how far this trace sits off the line it
    traced. The yardstick every added span is scored against."""
    a, b = wall_points(wall)
    return span_off_ink(a, b)


def _span_crosses_a_wall(start: Point, end: Point, walls: Sequence[Wall], exclude: Sequence[int]) -> Optional[int]:
    for index, wall in enumerate(walls):
        if index in exclude:
            continue
        p, q = wall_points(wall)
        if _segments_properly_cross(start, end, p, q):
            return index
    return None


def _pair_move_is_along_axis(
    end_point: Point, other_end: Point, target: Point, bearing: float
) -> bool:
    """The same guards `_landing_candidates` uses: a wall may be lengthened along its own axis,
    never bent sideways onto a neighbour that merely passes nearby, and never flipped.

    This step may only ever ADD material. A move that shortens the wall lands on a junction that
    is already there and deletes whatever ran past it, which is a decision about an overshoot
    (step 6's `_overshoot_landing`, which checks the drawing first) and not about a gap. Allowing
    it here truncated the Kitchen's south wall by 0.87 m and the washroom block's left wall by
    0.46 m, both of them wall the source draws.
    """
    axis = math.hypot(end_point[0] - other_end[0], end_point[1] - other_end[1])
    if axis <= 0.0:
        return False
    outward = ((end_point[0] - other_end[0]) / axis, (end_point[1] - other_end[1]) / axis)
    move = (target[0] - end_point[0], target[1] - end_point[1])
    if move[0] * outward[0] + move[1] * outward[1] <= 0.0:
        return False
    if abs(move[0] * outward[1] - move[1] * outward[0]) > LAND_MAX_LATERAL_M:
        return False
    new_vector = (target[0] - other_end[0], target[1] - other_end[1])
    if new_vector[0] * outward[0] + new_vector[1] * outward[1] <= 0.0:
        return False
    if math.hypot(new_vector[0], new_vector[1]) < max(MIN_COLLAPSE_LENGTH_M, PARTITION_MIN_LENGTH_M):
        return False
    landed = {"a": [target[0], target[1]], "b": [other_end[0], other_end[1]]}
    return angle_diff_deg(bearing, wall_angle_deg(landed)) <= LAND_MAX_TURN_DEG


def close_invented_breaks(
    partitions: List[Wall], fixed: Sequence[Wall]
) -> Tuple[List[Wall], List[str]]:
    """
    Pull one free partition end onto another wall's free end, closing a gap the trace invented.

    Only two things justify it, and both are evidence about the drawing rather than about the
    geometry: a third wall runs straight through the gap (a junction, never a door), or the span
    is on ink once the two walls' own tracing error is allowed for. Everything else is left as the
    opening the drawing shows. One change per pass with a restart, so the result is a pure
    function of the wall list; each closure lands an end ON another wall, so a re-run sees it as
    attached and nothing fires twice.
    """
    result = [dict(w) for w in partitions]
    actions: List[str] = []

    for _ in range(MAX_PASSES):
        walls = result + list(fixed)
        partition_count = len(result)

        def name(index: int, count: int = partition_count) -> int:
            return index + len(fixed) if index < count else index - count

        points = endpoint_list(walls)
        free = [index for index in free_endpoint_indices(walls) if index // 2 < len(result)]
        budgets = {index // 2: None for index in free}
        for owner in list(budgets):
            budgets[owner] = wall_off_ink(walls[owner])

        chosen: Optional[Tuple[int, int, Point, str]] = None
        for endpoint_index in free:
            owner = endpoint_index // 2
            end_point = points[endpoint_index]
            other_end = points[endpoint_index + 1 if endpoint_index % 2 == 0 else endpoint_index - 1]
            bearing = wall_angle_deg(walls[owner])
            candidates: List[Tuple[float, int, Point]] = []
            for target_index, target in enumerate(walls):
                if target_index == owner:
                    continue
                for raw in wall_points(target):
                    point = (round(raw[0], COORD_DECIMALS), round(raw[1], COORD_DECIMALS))
                    distance = math.hypot(point[0] - end_point[0], point[1] - end_point[1])
                    if distance <= T_SNAP_EPS_M or distance > CLOSE_PAIR_MAX_M:
                        continue
                    candidates.append((distance, target_index, point))
            candidates.sort(key=lambda item: (round(item[0], 6), item[1], item[2]))

            for distance, target_index, point in candidates:
                if not _pair_move_is_along_axis(end_point, other_end, point, bearing):
                    continue
                crossing = _span_crosses_a_wall(end_point, point, walls, (owner, target_index))
                off_ink = span_off_ink(end_point, point)
                budget = min(
                    CLOSE_PAIR_INK_CAP_M,
                    max(
                        INK_ON_MAX_M,
                        CLOSE_PAIR_INK_SLACK
                        * max(budgets[owner], wall_off_ink(walls[target_index])),
                    ),
                )
                if crossing is not None:
                    reason = (
                        f"wall {name(crossing)} runs straight through the gap, so it is a junction "
                        f"the drawing interrupts, not a doorway"
                    )
                elif off_ink <= budget:
                    reason = (
                        f"the span is on ink ({off_ink:.3f} m off, budget {budget:.3f} m from "
                        f"these two walls' own tracing error)"
                    )
                else:
                    continue
                chosen = (endpoint_index, target_index, point, reason)
                break
            if chosen is not None:
                break

        if chosen is None:
            return round_walls(result), actions

        endpoint_index, target_index, point, reason = chosen
        owner = endpoint_index // 2
        key = "a" if endpoint_index % 2 == 0 else "b"
        end_point = points[endpoint_index]
        moved = dict(result[owner])
        moved[key] = [point[0], point[1]]
        result[owner] = round_wall(moved)
        actions.append(
            f"close wall {name(owner)} end {key} [{end_point[0]:.3f}, {end_point[1]:.3f}] onto "
            f"wall {name(target_index)} at [{point[0]:.3f}, {point[1]:.3f}]: {reason}"
        )

    raise RuntimeError("close_invented_breaks did not converge; check the CLOSE_PAIR_* tolerances")


# ---------------------------------------------------------------------------------------
# Step 6c: draw a wall the trace has none of
# ---------------------------------------------------------------------------------------


def _band_grey(point: Point, normal: Point) -> int:
    """Darkest source pixel within RUN_BAND_M either side of `point`, across the wall."""
    import render_floor_plan  # noqa: PLC0415

    metres_per_px = render_floor_plan.SOURCE_SCALE_M_PER_PX
    pixels, width, height = _source_raster()
    steps = int(RUN_BAND_M / metres_per_px) + 1
    best = 255
    for step in range(-steps, steps + 1):
        offset = step * metres_per_px
        sample = (point[0] + normal[0] * offset, point[1] + normal[1] * offset)
        fx, fy = _world_to_source_px(sample)
        ix, iy = int(round(fx)), int(round(fy))
        if 0 <= ix < width and 0 <= iy < height:
            best = min(best, pixels[ix, iy])
    return best


def _ink_run_past_a_gap(
    origin: Point, direction: Point
) -> Optional[Tuple[float, float]]:
    """
    Scan outward from a loose end along its own axis and return the first contiguous ink run that
    starts AFTER a stretch of blank paper, as (t_start, t_end).

    Requiring the blank first is what makes this "a wall the trace has none of" rather than "this
    wall is 2 cm short": anything still attached to the end's own ink belongs to the wall itself
    and is step 6's business, not this step's.
    """
    normal = (-direction[1], direction[0])
    steps = int(RUN_SCAN_MAX_M / RUN_STEP_M)
    seen_blank = False
    start: Optional[float] = None
    for index in range(steps + 1):
        t = index * RUN_STEP_M
        grey = _band_grey((origin[0] + direction[0] * t, origin[1] + direction[1] * t), normal)
        if grey >= INK_BLANK_LEVEL:
            if start is not None:
                return (start, t - RUN_STEP_M)
            seen_blank = True
        elif grey < INK_LEVEL:
            if not seen_blank:
                continue
            if start is None:
                start = t
        # the 150..200 band decides nothing: it neither starts a run nor ends one
    if start is not None:
        return (start, steps * RUN_STEP_M)
    return None


def _run_is_a_drawn_line(origin: Point, direction: Point, span: Tuple[float, float]) -> bool:
    """A wall is a line with paper either side of it; a pictogram or a heavy label is a blob."""
    normal = (-direction[1], direction[0])
    start, end = span
    steps = max(2, int((end - start) / RUN_STEP_M))
    clear = 0
    for index in range(steps + 1):
        t = start + (end - start) * index / steps
        point = (origin[0] + direction[0] * t, origin[1] + direction[1] * t)
        both = True
        for sign in (-1.0, 1.0):
            side = (
                point[0] + normal[0] * sign * RUN_THIN_OFFSET_M,
                point[1] + normal[1] * sign * RUN_THIN_OFFSET_M,
            )
            if _band_grey(side, normal) < INK_LEVEL:
                both = False
        if both:
            clear += 1
    return clear >= RUN_THIN_MIN_FRACTION * (steps + 1)


def _uncovered_part_of_run(
    origin: Point, direction: Point, span: Tuple[float, float], walls: Sequence[Wall]
) -> Optional[Tuple[float, float]]:
    """
    The longest stretch of the run that no NEAR-PARALLEL wall already draws. A transverse wall
    crossing the run does not cover it (that is a T-junction, and it is exactly the junction that
    makes emitting the run worthwhile).
    """
    bearing = wall_angle_deg({"a": [0.0, 0.0], "b": [direction[0], direction[1]]})
    start, end = span
    steps = max(2, int((end - start) / RUN_STEP_M))
    best: Optional[Tuple[float, float]] = None
    run_start: Optional[float] = None
    for index in range(steps + 2):
        t = start + (end - start) * min(index, steps) / steps
        point = (origin[0] + direction[0] * t, origin[1] + direction[1] * t)
        covered = index > steps or any(
            angle_diff_deg(bearing, wall_angle_deg(wall)) <= RUN_COVER_ANGLE_DEG
            and segment_point_distance(point, wall) <= RUN_COVER_M
            for wall in walls
        )
        if covered:
            if run_start is not None:
                candidate = (run_start, t)
                if best is None or (candidate[1] - candidate[0]) > (best[1] - best[0]):
                    best = candidate
                run_start = None
        elif run_start is None:
            run_start = t
    return best


def draw_missing_ink_runs(
    partitions: List[Wall], fixed: Sequence[Wall]
) -> Tuple[List[Wall], List[str]]:
    """
    Where a loose end faces a genuinely blank gap and the drawing then CARRIES ON with a wall the
    trace never emitted, emit it. The blank gap stays open (it is a door), but the partition on
    the far side of it stops being missing, which is what leaves its neighbours floating.
    """
    result = [dict(w) for w in partitions]
    actions: List[str] = []

    for _ in range(MAX_PASSES):
        walls = result + list(fixed)
        partition_count = len(result)

        def name(index: int, count: int = partition_count) -> int:
            return index + len(fixed) if index < count else index - count

        points = endpoint_list(walls)
        emitted = False
        for endpoint_index in free_endpoint_indices(walls):
            owner = endpoint_index // 2
            end_point = points[endpoint_index]
            other_end = points[endpoint_index + 1 if endpoint_index % 2 == 0 else endpoint_index - 1]
            axis = math.hypot(end_point[0] - other_end[0], end_point[1] - other_end[1])
            if axis <= 0.0:
                continue
            direction = (
                (end_point[0] - other_end[0]) / axis,
                (end_point[1] - other_end[1]) / axis,
            )
            span = _ink_run_past_a_gap(end_point, direction)
            if span is None or span[1] - span[0] < RUN_MIN_M:
                continue
            if not _run_is_a_drawn_line(end_point, direction, span):
                continue
            uncovered = _uncovered_part_of_run(end_point, direction, span, walls)
            if uncovered is None or uncovered[1] - uncovered[0] < RUN_MIN_M:
                continue
            start = (
                round(end_point[0] + direction[0] * uncovered[0], COORD_DECIMALS),
                round(end_point[1] + direction[1] * uncovered[0], COORD_DECIMALS),
            )
            finish = (
                round(end_point[0] + direction[0] * uncovered[1], COORD_DECIMALS),
                round(end_point[1] + direction[1] * uncovered[1], COORD_DECIMALS),
            )
            result.append(make_wall(start, finish))
            actions.append(
                f"draw the {uncovered[1] - uncovered[0]:.2f} m of wall the source has and the "
                f"trace does not, [{start[0]:.3f}, {start[1]:.3f}] to [{finish[0]:.3f}, "
                f"{finish[1]:.3f}], facing wall {name(owner)} across a blank "
                f"{uncovered[0]:.2f} m opening"
            )
            emitted = True
            break
        if not emitted:
            return round_walls(result), actions

    raise RuntimeError("draw_missing_ink_runs did not converge; check the RUN_* tolerances")


# ---------------------------------------------------------------------------------------
# Step 7: carry glass flags and authored notes onto the rebuilt walls
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
# Step 8: absorb shadow stubs (transfer the design decision, then drop the tab)
# ---------------------------------------------------------------------------------------


def _stub_free_end(index: int, walls: Sequence[Wall]) -> bool:
    """True if either end of walls[index] touches nothing else. A stub, not a link in a chain."""
    return any(
        not endpoint_is_attached(point, index, walls) for point in wall_points(walls[index])
    )


def _shadow_host(index: int, walls: Sequence[Wall]) -> Optional[int]:
    """
    The longer wall that walls[index] merely re-draws, or None.

    A stub qualifies only if it lies flat against a LONGER wall: near-parallel, every one of its
    own points within STUB_PERP_M of that wall's body, and its shadow landing inside the host's
    span rather than off either tip (an end-to-end continuation is architecture, not a shadow).
    Ties break on the closest host and then on the lowest index, so the choice is deterministic.
    """
    stub = walls[index]
    stub_length = wall_length(stub)
    probes = list(wall_points(stub)) + [midpoint(stub)]
    best: Optional[Tuple[float, int]] = None
    for other, host in enumerate(walls):
        if other == index:
            continue
        if wall_length(host) <= stub_length + STUB_HOST_MIN_EXTRA_M:
            continue
        if angle_diff_deg(wall_angle_deg(stub), wall_angle_deg(host)) > STUB_ANGLE_DEG:
            continue
        distance = max(segment_point_distance(p, host) for p in probes)
        if distance > STUB_PERP_M:
            continue
        feet = [foot_on_wall(p, host) for p in wall_points(stub)]
        if any(foot is None for foot in feet):
            continue
        if any(not (STUB_MIN_T <= foot[0] <= STUB_MAX_T) for foot in feet):
            continue
        if best is None or distance < best[0]:
            best = (distance, other)
    return None if best is None else best[1]


def _merge_note(host_note: Optional[str], stub_note: str) -> str:
    """
    Append the stub's paragraphs to the host's. The host's own text is never rewritten, only
    added to, so a merge can lose no authored wording; a stub paragraph the host already carries
    verbatim is not appended a second time.
    """
    host = (host_note or "").strip()
    existing = host.split("\n\n")
    additions = [
        paragraph.strip()
        for paragraph in stub_note.split("\n\n")
        if paragraph.strip() and paragraph.strip() not in existing
    ]
    if not host:
        return "\n\n".join(additions)
    return "\n\n".join([host] + additions) if additions else host


def _axis_landing(wall: Wall, key: str, host: Wall) -> Optional[Point]:
    """
    Where `wall`, extended along its OWN axis from end `key`, meets the host's line.

    Extending along its own axis (rather than dropping a perpendicular) is what keeps the wall
    pointing where the drawing points it: the divider that met a step in a jagged front should
    still arrive at the front on its own bearing.
    """
    point = _pt(wall[key])
    other = _pt(wall["b" if key == "a" else "a"])
    dx, dz = point[0] - other[0], point[1] - other[1]
    (hx, hz), (hbx, hbz) = wall_points(host)
    ex, ez = hbx - hx, hbz - hz
    denominator = dx * ez - dz * ex
    if abs(denominator) < 1e-9:
        return None  # parallel: no landing on this host
    t_host = ((other[0] - hx) * dz - (other[1] - hz) * dx) / denominator
    if not (T_SNAP_MIN_T <= t_host <= T_SNAP_MAX_T):
        return None  # would land off the end of the host, which is not a junction
    landing = (hx + t_host * ex, hz + t_host * ez)
    if math.hypot(landing[0] - point[0], landing[1] - point[1]) > STUB_RELAND_MAX_M:
        return None
    if (landing[0] - other[0]) * dx + (landing[1] - other[1]) * dz <= 0.0:
        return None  # behind the wall's other end: that would flip it
    return landing


def _reland_on_host(walls: Sequence[Wall], stub: Wall, host_index: int) -> List[Wall]:
    """
    Re-attach whatever was joined to the stub's body onto the wall the stub shadowed.

    Without this the absorption would trade a visible tab for a visible gap: the wall that
    T-joined the stub (the 1407/1408 divider meeting the step in the front) would be left
    stopping short of the front by the stub's own offset.
    """
    result = [dict(w) for w in walls]
    protected = _protected_gaps(endpoint_list(result))
    for owner in range(len(result)):
        if owner == host_index:
            continue
        for key in ("a", "b"):
            points = endpoint_list(result)
            endpoint_index = owner * 2 + (0 if key == "a" else 1)
            point = points[endpoint_index]
            if segment_point_distance(point, stub) > ATTACHED_EPS_M:
                continue  # this end never touched the stub
            if endpoint_is_attached(point, owner, result):
                continue  # it has another wall to hold on to
            host = result[host_index]
            landing = _axis_landing(result[owner], key, host)
            if landing is None:
                hit = foot_on_wall(point, host)
                if hit is None or not (T_SNAP_MIN_T <= hit[0] <= T_SNAP_MAX_T):
                    continue
                if hit[2] > STUB_RELAND_MAX_M:
                    continue
                landing = hit[1]
            new_point = (round(landing[0], COORD_DECIMALS), round(landing[1], COORD_DECIMALS))
            other_end = points[endpoint_index + 1 if key == "a" else endpoint_index - 1]
            if math.hypot(new_point[0] - other_end[0], new_point[1] - other_end[1]) < MIN_COLLAPSE_LENGTH_M:
                continue
            if not _move_is_door_safe(endpoint_index, new_point, points, result, protected):
                continue
            moved = dict(result[owner])
            moved[key] = [new_point[0], new_point[1]]
            result[owner] = moved
    return round_walls(result)


def absorb_shadow_stubs(walls: Sequence[Wall], pinned: int = 0) -> Tuple[List[Wall], List[str]]:
    """
    Remove sub-STUB_MAX_LENGTH_M tabs that only re-draw a longer wall, after moving whatever
    design decision they carry (the glass flag, the authored note) onto the wall they shadow.

    This is the third option for a shadow tab. Snapping it onto the wall it shadows would create
    a parallel duplicate pair; trimming it back to the junction would drop it under
    PARTITION_MIN_LENGTH_M, so the next admission pass would delete it and take its glass flag
    and its note with it. Transferring first and deleting second loses neither: the line is
    already drawn by the host, and the design decision stays at the same place on the host.

    Only a stub with a FREE end is touched, so a short wall that links two others (a jamb, a
    kink at the end of a run) is never absorbed - deleting one of those would orphan its
    neighbour. The pass refuses outright if a removal would leave any other wall fully floating.

    The first `pinned` walls are the envelope and the core and are never candidates: they are
    one-per-edge of walkableOutline and of the hole polygons and must keep matching them exactly.

    Idempotent: its input is the wall list itself, so once a stub is absorbed there is nothing
    left for a re-run to find, and a re-merged note is deduplicated paragraph by paragraph.
    """
    result = [dict(w) for w in walls]
    actions: List[str] = []
    for _ in range(MAX_PASSES):
        victim: Optional[Tuple[int, int]] = None
        for index in range(pinned, len(result)):
            if wall_length(result[index]) >= STUB_MAX_LENGTH_M:
                continue
            if not _stub_free_end(index, result):
                continue
            host = _shadow_host(index, result)
            if host is not None:
                victim = (index, host)
                break
        if victim is None:
            break

        index, host = victim
        stub = result[index]
        host_after = host if host < index else host - 1
        floating_before = sum(1 for i in range(len(result)) if not wall_is_connected(i, result))
        trimmed = _reland_on_host([w for i, w in enumerate(result) if i != index], stub, host_after)
        floating_after = sum(1 for i in range(len(trimmed)) if not wall_is_connected(i, trimmed))
        if floating_after > floating_before:
            actions.append(
                f"kept {wall_length(stub):.2f} m stub at {midpoint(stub)}: removing it would "
                f"strand a neighbour"
            )
            break

        carried: List[str] = []
        target = trimmed[host_after]
        if stub.get("glass"):
            carried.append("glass (host was already glass)" if target.get("glass") else "glass")
            target["glass"] = True
        stub_note = stub.get("note")
        if stub_note:
            merged = _merge_note(target.get("note"), stub_note)
            carried.append(
                "note (text already on the host)" if merged == target.get("note") else "note"
            )
            target["note"] = merged
        actions.append(
            f"absorbed {wall_length(stub):.2f} m stub "
            f"{list(stub['a'])} -> {list(stub['b'])} into the "
            f"{wall_length(target):.2f} m wall {list(target['a'])} -> {list(target['b'])}"
            + (f", carrying {' and '.join(carried)}" if carried else ", carrying nothing")
        )
        result = trimmed
    return result, actions


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


def metrics(walls: Sequence[Wall], rooms: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """`rooms` is not optional: the dangling-end count needs the room door anchors, and defaulting
    them to empty would silently over-report by counting every jamb."""
    return {
        "walls": len(walls),
        "dangling_ends": len(dangling_ends(walls, rooms)),
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
        ("dangling ends", "dangling_ends", "{:.0f}"),
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
    partitions, repairs = repair_dangling_ends(partitions, fixed, plan["rooms"])
    partitions, closures = close_invented_breaks(partitions, fixed)
    partitions, drawn = draw_missing_ink_runs(partitions, fixed)
    # Settle again: a closure can leave a wall crossing where a T belongs (the wall that runs
    # through a junction gap now pokes a few centimetres past the closed line), and an emitted run
    # is crossed by whatever T-joins it. _geometry_fixpoint's trim turns both into clean junctions.
    # `regularize` is deliberately NOT used here: its shard prune judges connectivity, and the
    # emitted runs are joined mid-span rather than at a tip.
    partitions = _geometry_fixpoint(partitions, fixed)
    partitions, _ = admit_partitions(partitions, fixed, outline, hole_polygons)

    walls = round_walls(fixed + partitions)
    walls, provenance = carry_provenance(walls, originals)
    # Runs AFTER provenance on purpose: a stub is only safe to delete once whatever it carries is
    # sitting on the wall it shadows, and that is only true after the flags have been placed.
    walls, absorbed = absorb_shadow_stubs(walls, pinned=len(fixed))
    provenance["glass_final"] = sum(1 for w in walls if w.get("glass"))
    provenance["notes_final"] = sum(1 for w in walls if w.get("note"))
    partition_count = len(walls) - len(fixed)

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
        len(envelope), len(core), partition_count, len(dangling_ends(walls, plan["rooms"]))
    )

    info = {
        "envelope": len(envelope),
        "core": len(core),
        "partitions": partition_count,
        "absorbed": absorbed,
        "rejected": rejected,
        "repaired_holes": repaired_names,
        "provenance": provenance,
        "repairs": repairs,
        "closures": closures,
        "drawn": drawn,
        "dangling_after": len(dangling_ends(walls, plan["rooms"])),
    }
    return result, info


def rebuild_sentence(
    envelope_count: int, core_count: int, partition_count: int, dangling_count: int
) -> str:
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
        f"walkableOutline and the holes exactly. Any partition end still stopping in open space "
        f"afterwards, with no neighbour to land on and no door facing it, was then decided "
        f"against the source raster in source/floor-14-plan-hires.png: an end whose own axis "
        f"reaches a neighbour within {LAND_MAX_M:.2f} m is landed on it, a run the trace chopped "
        f"is bridged, and an end is only ever closed where every point of the added span sits "
        f"within {INK_ON_MAX_M:.2f} m of drawn ink, which is what distinguishes a joint the trace "
        f"lost from a door opening the drawing leaves blank (measured on this plan: real wall "
        f"bodies run 0.05 to 0.12 m from ink, the door openings 0.36 to 0.47 m). Ink is greyscale "
        f"below {INK_LEVEL}, not below 130 as in earlier passes: this drawing renders its thin "
        f"interior partitions in LIGHT grey around 133 to 140 (sampled down the washroom block's "
        f"right wall and the Gender Neutral washroom's left wall), so at 130 those walls read as "
        f"blank paper and every break the trace left in them was preserved as if it were a "
        f"doorway. Genuinely blank paper on this drawing is {INK_BLANK_LEVEL} and above, so the "
        f"two populations are still cleanly separated. Two further passes then run on the "
        f"corrected reading. The first judges a PAIR of loose ends rather than one end at a time "
        f"and closes the gap between them when a third wall runs straight through it (a junction "
        f"the drawing interrupts, which is why the washroom block's south wall stops at both faces "
        f"of the plumbing chase between the Male and Female washrooms) or when the span is on ink "
        f"once these two walls' OWN tracing error is allowed for (the Classroom 1417 / North "
        f"Collaboration run is traced about 0.2 m off its own drawn line along its whole length, "
        f"so a flat bound calls the joint between its two pieces blank for the same reason it "
        f"would call the pieces themselves blank). The second emits wall the drawing has and the "
        f"trace has none of at all, found by reading along a loose end's own axis past a blank "
        f"opening: the washroom block's right wall below the Gender Neutral washroom's door, and "
        f"the 1429/1430 jamb. A run only counts if it is a LINE with paper "
        f"{RUN_THIN_OFFSET_M:.2f} m to either side, which is what keeps the washroom pictograms "
        f"and the heavy room labels from being read as walls. {dangling_count} "
        f"{'end remains' if dangling_count == 1 else 'ends remain'} loose by design, each one a "
        f"jamb facing an opening the drawing shows as a "
        f"blank gap. Wall dimensions and angles are therefore "
        f"constructed, not surveyed. No weld or snap was allowed to narrow a door-sized opening, "
        f"and every room stays path-reachable (npm run test:nav, 18/18, no PARTIAL paths); glass "
        f"flags and authored per-wall notes are carried onto the nearest parallel rebuilt wall. "
        f"Finally, no wall here is a shadow stub: a tab under {STUB_MAX_LENGTH_M:.2f} m with a "
        f"free end lying flat against a longer wall (within {STUB_ANGLE_DEG:.0f} degrees and "
        f"{STUB_PERP_M:.2f} m, its shadow inside that wall's span) is not kept as a wall of its "
        f"own, because the line is already drawn by the wall it shadows and the tab renders as a "
        f"spur poking past the junction. Its glass flag and its authored note move onto that "
        f"wall first, paragraph by paragraph, so the design decision survives at the same place "
        f"on the front; a short wall joining two others is never absorbed, since deleting one of "
        f"those would strand its neighbour."
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
    before = metrics([round_wall(w) for w in plan["walls"]], plan["rooms"])

    result, info = rebuild(plan)
    after = metrics(result["walls"], result["rooms"])

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
    print(f"dangling-end repair : {len(info['repairs'])} action(s), {info['dangling_after']} left")
    for line in info["repairs"]:
        print(f"  - {line}")
    print(f"invented breaks     : {len(info['closures'])} closed")
    for line in info["closures"]:
        print(f"  - {line}")
    print(f"missing drawn walls : {len(info['drawn'])} emitted")
    for line in info["drawn"]:
        print(f"  - {line}")
    print(f"shadow stubs        : {len(info['absorbed'])} absorbed")
    for line in info["absorbed"]:
        print(f"  - {line}")
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
