#!/usr/bin/env python3
"""
Re-derive the Wellness Room's `center` and `door` anchors in floor-14.json from the plan's
own geometry plus the source drawing, and sweep every room's anchors for the same defect.

WHY THIS EXISTS
---------------
`rooms[]` in floor-14.json was never produced by the tracing pipeline. Per the file's own
`note`, the room anchors are "carried over byte-for-byte from the prior (473px-source) file:
they were hand-matched to each room's real label/doorway position". One of those hand
placements is wrong: the Wellness Room's anchors sit ON the wall that forms the room's NORTH
boundary instead of inside the room.

    "Wellness Room"  center = [12.512, 5.344]   door = [11.800, 5.087]

    center is 0.142 m from walls[35]  (a=[18.743, 6.039]  b=[11.366, 5.046], 7.44 m long)
    door   is 0.017 m from that same wall

That wall is CORRECT: it traces the real drawn line that closes the Wellness Room off from
the corridor to its north. The room's actual interior is the small nook SOUTH of it (smaller
z), which is where the source drawing prints the words "Wellness Room". So the anchors are
misplaced, not the geometry.

This matters beyond looks. `rooms[].center` is the 3D label anchor in world-client
(RoomLabels.tsx) AND `nav.findRoomTarget` resolves "take me to the Wellness Room" to these
coordinates, so navigation currently targets a point standing on a wall.

WHAT THIS SCRIPT MAY AND MAY NOT TOUCH
--------------------------------------
It rewrites `rooms[]` entries ONLY, and only the named room. `walls`, `holes`,
`walkableOutline`, `entrance`, `units`, `floor`, `source` and `note` are copied through
untouched. Both copies of the file (world/data and world-client/public/data, which
world-client's floorPlanSync test asserts are byte identical) are written together.

METHOD
------
The nook is not fully enclosed by `walls[]`. Its west side is a drawn wall line that the
raster trace never admitted (it is two short jamb stubs with a door gap between them, and the
trace's minimum-length filter drops stubs that short). So the nook has to be closed before it
can be measured, and the closing line is exactly where the door lives. Three stages:

  1. CLOSING LINE (west boundary), derived by ink sweep, not eyeballed.
     `walls[35]`'s west endpoint is a loose end: nothing in `walls[]` attaches to it. Sweep a
     ray out of that endpoint over every heading, terminate each candidate on the first
     `walls[]` segment it hits, and score the candidate by what fraction of its length runs
     over drawn ink in the source raster. The best-scoring heading IS the drawn wall line the
     trace missed. Ink is greyscale < INK_MAX (150, the same threshold rebuild_floor_plan.py
     settled on for this drawing: its thin interior partitions render in light grey ~133-140,
     and genuinely blank paper is 200+). "On ink" means ink within ON_INK_M (0.09 m, half the
     rendered wall thickness), also matching that pipeline.

  2. DOOR = the middle of the drawn opening in that closing line.
     Walk the winning line and split it into ink runs and blank runs. The jamb stubs are the
     ink runs; the single wide blank run between them is the doorway the drawing leaves open.
     The door anchor is that blank run's midpoint. Nothing is hand-typed: the run boundaries
     come from the ink samples.

  3. CENTER = the pole of inaccessibility of the closed nook.
     Rasterize `walls[]` plus the closing line, flood fill from a seed to get the nook as a
     connected free-space pocket, and take the pocket point whose distance to the nearest
     boundary segment is largest (grid search, then a local refinement at 1 mm). That is the
     largest inscribed circle's center, i.e. the most comfortably interior point available.
     The seed is chosen without assuming a side: step off `walls[35]` both ways at the old
     centre's foot, flood fill each, and keep the SMALLER component. The nook is enclosed; the
     other side opens into the whole floor, so the areas are not close.

VERIFICATION BUILT IN
---------------------
  * Both new anchors are asserted to lie strictly inside the flood-filled pocket.
  * Clearance is re-measured exactly (point-to-segment, not off the raster) against `walls[]`
    and against `walls[]` + the closing line, and asserted above AGENT_RADIUS_M * 2.
  * The door is asserted to be on blank paper, and to be no further from the new centre than
    roomDoorSanity.test.ts's own bound (that test's rule is reimplemented here so a violation
    is caught at derivation time, not two commands later).
  * `--sweep` prints the same anchor audit for all 18 rooms: centre-to-nearest-wall,
    door-to-nearest-wall, and whether either point is buried inside wall material (nearest
    point interior to the wall's span AND within half the rendered 0.15 m thickness).
  * `--overlay PATH` writes a zoomed source crop with the walls, the derived closing line and
    the old/new anchors drawn on it, so the result can be checked against the printed label.

USAGE
-----
    python world/data/tools/fix_room_anchors.py --sweep            # audit only, writes nothing
    python world/data/tools/fix_room_anchors.py --dry-run          # derive + audit, no write
    python world/data/tools/fix_room_anchors.py --apply            # derive + write both copies
    python world/data/tools/fix_room_anchors.py --apply --overlay out.png

Then re-run the gates:
    cd world && npm run test:nav
    cd world-client && npm test
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

Point = Tuple[float, float]
Segment = Tuple[Point, Point]

HERE = os.path.dirname(os.path.abspath(__file__))
WORLD_DATA = os.path.normpath(os.path.join(HERE, ".."))
REPO = os.path.normpath(os.path.join(WORLD_DATA, "..", ".."))
PLAN_SERVER = os.path.join(WORLD_DATA, "floor-14.json")
PLAN_CLIENT = os.path.join(REPO, "world-client", "public", "data", "floor-14.json")
SOURCE_PNG = os.path.join(WORLD_DATA, "source", "floor-14-plan-hires.png")

# --- source-image transform -------------------------------------------------------------
# From floor-14.json's own `note`: ONE uniform scale, image y flipped so z grows north. The
# building's wall-network bounding box starts at pixel (0, 1) in the 636x489 canvas and is
# 629x471 px, so world z = (471 - (py - 1)) * S  =>  py = 472 - z / S.
PX_PER_M = 0.055644  # metres per pixel
PY_ORIGIN = 472.0

# --- ink / geometry constants (all inherited from rebuild_floor_plan.py's tuning) --------
INK_MAX = 150  # greyscale below this is drawn ink; blank paper on this drawing is 200+
ON_INK_M = 0.09  # half the rendered wall thickness: "the drawn line is under this wall"
RENDERED_WALL_THICKNESS_M = 0.15
HALF_WALL_M = RENDERED_WALL_THICKNESS_M / 2.0
AGENT_RADIUS_M = 0.20  # world/src/nav/agentProfile.ts
MIN_CENTER_CLEARANCE_M = AGENT_RADIUS_M * 2.0

# --- closing-line sweep ------------------------------------------------------------------
SWEEP_MAX_LEN_M = 4.0  # a candidate closing line longer than this is not a room's own wall
SWEEP_STEP_DEG = 0.25
MIN_TURN_DEG = 25.0  # a candidate within this of the parent wall's own heading is that wall
SAMPLE_STEP_M = 0.01  # how finely a candidate line is sampled for ink
MIN_DOOR_GAP_M = 0.30  # a blank run shorter than this is a trace gap, not a doorway
MAX_DOOR_GAP_M = 1.20  # a blank run longer than this means the side is open, not a doorway

# --- pocket raster -----------------------------------------------------------------------
RASTER_M = 0.01  # flood-fill cell size
SEED_OFFSET_M = 0.30  # how far off the wall to drop the two candidate seeds

# --- roomDoorSanity.test.ts's own bound, reimplemented so we fail here first --------------
WALL_SEARCH_CAP_M = 6.0
DOOR_WALL_MARGIN_M = 1.0

TARGET_ROOM = "Wellness Room"


# =========================================================================================
# small geometry helpers
# =========================================================================================
def seg_point_distance(p: Point, seg: Segment) -> float:
    """Perpendicular distance from p to the finite segment seg."""
    (ax, az), (bx, bz) = seg
    dx, dz = bx - ax, bz - az
    denom = dx * dx + dz * dz
    if denom < 1e-18:
        return math.hypot(p[0] - ax, p[1] - az)
    u = ((p[0] - ax) * dx + (p[1] - az) * dz) / denom
    u = max(0.0, min(1.0, u))
    return math.hypot(p[0] - (ax + u * dx), p[1] - (az + u * dz))


def seg_point_foot(p: Point, seg: Segment) -> Tuple[float, float]:
    """(clamped parameter u along seg, perpendicular distance to the INFINITE line)."""
    (ax, az), (bx, bz) = seg
    dx, dz = bx - ax, bz - az
    denom = dx * dx + dz * dz
    if denom < 1e-18:
        return 0.0, math.hypot(p[0] - ax, p[1] - az)
    u = ((p[0] - ax) * dx + (p[1] - az) * dz) / denom
    perp = abs((p[0] - ax) * dz - (p[1] - az) * dx) / math.sqrt(denom)
    return u, perp


def ray_hits_segment(origin: Point, direction: Point, seg: Segment) -> Optional[float]:
    """Distance from origin to where ray (origin, direction) crosses seg, or None.

    Same solve as roomDoorSanity.test.ts's rayHitsSegment, kept identical on purpose.
    """
    (ax, az), (bx, bz) = seg
    seg_x, seg_z = bx - ax, bz - az
    denom = direction[0] * seg_z - direction[1] * seg_x
    if abs(denom) < 1e-9:
        return None
    to_a_x, to_a_z = ax - origin[0], az - origin[1]
    t = (to_a_x * seg_z - to_a_z * seg_x) / denom
    u = (to_a_x * direction[1] - to_a_z * direction[0]) / denom
    if t < 1e-6 or u < 0.0 or u > 1.0:
        return None
    return t


def nearest_wall_toward(center: Point, door: Point, segs: Sequence[Segment], cap: float):
    """roomDoorSanity.test.ts's nearestWallToward, reimplemented."""
    dx, dz = door[0] - center[0], door[1] - center[1]
    length = math.hypot(dx, dz)
    if length < 1e-6:
        return None
    unit = (dx / length, dz / length)
    nearest = None
    for seg in segs:
        hit = ray_hits_segment(center, unit, seg)
        if hit is not None and hit <= cap and (nearest is None or hit < nearest):
            nearest = hit
    return nearest


def door_sanity_bound(center: Point, door: Point, segs: Sequence[Segment]) -> Tuple[float, float]:
    """(actual centre-to-door distance, the bound roomDoorSanity.test.ts allows)."""
    dist = math.hypot(center[0] - door[0], center[1] - door[1])
    if dist < 1e-6:
        return 0.0, math.inf
    wall_dist = nearest_wall_toward(center, door, segs, WALL_SEARCH_CAP_M)
    bound = (
        WALL_SEARCH_CAP_M + DOOR_WALL_MARGIN_M
        if wall_dist is None
        else wall_dist + DOOR_WALL_MARGIN_M
    )
    return dist, bound


# =========================================================================================
# source raster
# =========================================================================================
class SourceInk:
    """The source drawing's STRUCTURAL ink, queryable in world metres.

    Structural means "part of the building's own line work", as opposed to the room labels
    printed on top of it. The separation is not a hand-drawn box or a magic threshold: it uses
    the fact floor-14.json's own `note` states about this drawing, that the wall network (the
    outer envelope plus every partition touching it) is ONE pixel-connected component. So:
    label every 8-connected component of the ink mask, then keep only the components that some
    `walls[]` centreline actually runs through. The traced walls ARE that component, the short
    jamb stubs the trace dropped are drawn touching it, and the "Wellness Room" / "Classroom"
    label glyphs are free-floating islands that no wall centreline passes through.

    Without this the label text is indistinguishable from wall ink, and it matters here: the
    "R" of "Room" is printed directly across the Wellness Room's doorway, so an ink test that
    counts glyphs reports the doorway as two 0.26 m gaps with a wall between them.
    """

    def __init__(self, path: str, walls: Sequence[Segment]) -> None:
        grey = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if grey is None:
            raise SystemExit(f"cannot read source image {path}")
        self.grey = grey
        self.ink = grey < INK_MAX

        count, labels = cv2.connectedComponents(self.ink.astype(np.uint8), connectivity=8)
        h, w = labels.shape
        keep = set()
        for seg in walls:
            for _, p in sample_line(seg[0], seg[1], SAMPLE_STEP_M):
                px, py = p[0] / PX_PER_M, PY_ORIGIN - p[1] / PX_PER_M
                cx, cy = int(round(px)), int(round(py))
                # the trace runs within ~2 px of the drawn line, so look in a small window
                for dy in (-2, -1, 0, 1, 2):
                    for dx in (-2, -1, 0, 1, 2):
                        x, y = cx + dx, cy + dy
                        if 0 <= x < w and 0 <= y < h and labels[y, x]:
                            keep.add(int(labels[y, x]))
        self.structural = np.isin(labels, list(keep)) if keep else np.zeros_like(self.ink)
        dropped = int(self.ink.sum() - self.structural.sum())
        print(
            f"source ink: {int(self.ink.sum())} px in {count - 1} components; kept "
            f"{len(keep)} structural component(s), dropped {dropped} px of label/glyph ink"
        )

        # Distance (in pixels) from every pixel to the nearest structural ink pixel. cv2 wants
        # the "free" side as non-zero, so ink is 0 and paper is 255.
        free = np.where(self.structural, 0, 255).astype(np.uint8)
        self.dist_px = cv2.distanceTransform(free, cv2.DIST_L2, 5)

    def to_px(self, p: Point) -> Tuple[float, float]:
        return (p[0] / PX_PER_M, PY_ORIGIN - p[1] / PX_PER_M)

    def ink_distance_m(self, p: Point) -> float:
        """Distance in metres from world point p to the nearest STRUCTURAL ink pixel."""
        px, py = self.to_px(p)
        ix, iy = int(round(px)), int(round(py))
        h, w = self.dist_px.shape
        if not (0 <= ix < w and 0 <= iy < h):
            return math.inf
        return float(self.dist_px[iy, ix]) * PX_PER_M

    def on_ink(self, p: Point) -> bool:
        return self.ink_distance_m(p) <= ON_INK_M


# =========================================================================================
# stage 1: the closing line the trace missed
# =========================================================================================
def loose_end_of(wall_index: int, walls: Sequence[Segment], which: str) -> Point:
    """The named endpoint of a wall, asserted to be a LOOSE end (nothing else attaches)."""
    seg = walls[wall_index]
    p = seg[0] if which == "a" else seg[1]
    touching = 0
    for i, other in enumerate(walls):
        if i == wall_index:
            continue
        if seg_point_distance(p, other) <= 0.05:
            touching += 1
    if touching:
        raise SystemExit(
            f"walls[{wall_index}].{which} = {p} is not a loose end ({touching} walls touch it); "
            "the closing-line derivation assumes the room's west side is the open one"
        )
    return p


def sample_line(a: Point, b: Point, step: float = SAMPLE_STEP_M) -> List[Tuple[float, Point]]:
    """Evenly spaced (distance-from-a, point) samples along segment a->b."""
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    n = max(2, int(round(length / step)) + 1)
    out = []
    for i in range(n):
        t = i / (n - 1)
        out.append((t * length, (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))))
    return out


def sweep_closing_line(
    origin: Point, walls: Sequence[Segment], ink: SourceInk, parent: Segment
) -> Tuple[Point, float, List[Tuple[float, Point]]]:
    """Find the drawn wall line running out of `origin`, by ink coverage over a heading sweep.

    Every candidate heading is terminated on the first walls[] segment the ray crosses (that
    is where the room's own boundary is closed off), then scored by the fraction of its
    samples that sit on ink. Headings within MIN_TURN_DEG of `parent`'s own heading are
    skipped: `origin` sits ON that wall, so those candidates just retrace it and score 100%
    ink without describing anything new. Returns (far endpoint, coverage, samples).
    """
    parent_theta = math.atan2(parent[1][1] - parent[0][1], parent[1][0] - parent[0][0])
    best = None
    steps = int(round(360.0 / SWEEP_STEP_DEG))
    for i in range(steps):
        theta = math.radians(i * SWEEP_STEP_DEG)
        delta = abs(math.degrees(math.atan2(math.sin(theta - parent_theta), math.cos(theta - parent_theta))))
        if min(delta, 180.0 - delta) < MIN_TURN_DEG:
            continue
        direction = (math.cos(theta), math.sin(theta))
        hit = None
        for seg in walls:
            t = ray_hits_segment(origin, direction, seg)
            if t is not None and t <= SWEEP_MAX_LEN_M and (hit is None or t < hit):
                hit = t
        if hit is None or hit < 0.5:
            continue
        far = (origin[0] + hit * direction[0], origin[1] + hit * direction[1])
        samples = sample_line(origin, far)
        covered = sum(1 for _, p in samples if ink.on_ink(p))
        coverage = covered / len(samples)
        if best is None or coverage > best[1]:
            best = (far, coverage, samples)
    if best is None:
        raise SystemExit(f"no candidate closing line out of {origin} hit any wall")
    return best


def runs_along(samples: Sequence[Tuple[float, Point]], ink: SourceInk):
    """Split the sampled line into consecutive (is_ink, start_m, end_m) runs."""
    flags = [ink.on_ink(p) for _, p in samples]
    runs = []
    start = 0
    for i in range(1, len(flags) + 1):
        if i == len(flags) or flags[i] != flags[start]:
            runs.append((flags[start], samples[start][0], samples[i - 1][0]))
            start = i
    return runs


def door_from_runs(samples, ink: SourceInk, a: Point, b: Point) -> Tuple[Point, float]:
    """The doorway = the widest blank run strictly between two ink runs. Returns (point, width)."""
    runs = runs_along(samples, ink)
    candidates = []
    for i, (is_ink, s, e) in enumerate(runs):
        if is_ink:
            continue
        if i == 0 or i == len(runs) - 1:
            continue  # a blank run at either end is the trace stopping short, not a doorway
        width = e - s
        if MIN_DOOR_GAP_M <= width <= MAX_DOOR_GAP_M:
            candidates.append((width, s, e))
    if not candidates:
        raise SystemExit(
            "no blank run on the closing line looks like a doorway; runs were: "
            + ", ".join(f"{'ink' if f else 'gap'} {s:.2f}-{e:.2f}m" for f, s, e in runs)
        )
    width, s, e = max(candidates)
    total = math.hypot(b[0] - a[0], b[1] - a[1])
    mid = (s + e) / 2.0 / total
    return (a[0] + mid * (b[0] - a[0]), a[1] + mid * (b[1] - a[1])), width


# =========================================================================================
# stage 3: the pocket and its pole of inaccessibility
# =========================================================================================
def flood_pocket(seed: Point, boundary: Sequence[Segment], bbox) -> Tuple[np.ndarray, Tuple[float, float], int]:
    """Flood fill free space from `seed` against a raster of `boundary`. Returns (mask, origin, cells)."""
    min_x, min_z, max_x, max_z = bbox
    w = int(math.ceil((max_x - min_x) / RASTER_M)) + 1
    h = int(math.ceil((max_z - min_z) / RASTER_M)) + 1
    grid = np.zeros((h, w), np.uint8)

    def to_cell(p: Point) -> Tuple[int, int]:
        return (int(round((p[0] - min_x) / RASTER_M)), int(round((p[1] - min_z) / RASTER_M)))

    for seg in boundary:
        c0, c1 = to_cell(seg[0]), to_cell(seg[1])
        cv2.line(grid, c0, c1, 255, 3)

    sx, sy = to_cell(seed)
    if not (0 <= sx < w and 0 <= sy < h) or grid[sy, sx]:
        return np.zeros((h, w), bool), (min_x, min_z), 0

    mask = np.zeros((h + 2, w + 2), np.uint8)
    filled = grid.copy()
    cv2.floodFill(filled, mask, (sx, sy), 128, flags=4 | (255 << 8))
    pocket = filled == 128
    return pocket, (min_x, min_z), int(pocket.sum())


def pole_of_inaccessibility(
    pocket: np.ndarray, origin: Tuple[float, float], boundary: Sequence[Segment]
) -> Tuple[Point, float]:
    """The pocket point furthest from every boundary segment (grid search, then 1 mm refine)."""
    min_x, min_z = origin
    ys, xs = np.nonzero(pocket)
    best_p, best_d = None, -1.0
    for gy, gx in zip(ys, xs):
        p = (min_x + gx * RASTER_M, min_z + gy * RASTER_M)
        d = min(seg_point_distance(p, s) for s in boundary)
        if d > best_d:
            best_d, best_p = d, p
    # local refinement: shrink a search box around the winner down to 1 mm
    step = RASTER_M
    while step > 0.001:
        step /= 2.0
        improved = True
        while improved:
            improved = False
            for dx in (-step, 0.0, step):
                for dz in (-step, 0.0, step):
                    if dx == 0.0 and dz == 0.0:
                        continue
                    q = (best_p[0] + dx, best_p[1] + dz)
                    d = min(seg_point_distance(q, s) for s in boundary)
                    if d > best_d + 1e-9:
                        best_d, best_p, improved = d, q, True
    return best_p, best_d


def point_in_pocket(p: Point, pocket: np.ndarray, origin: Tuple[float, float]) -> bool:
    gx = int(round((p[0] - origin[0]) / RASTER_M))
    gy = int(round((p[1] - origin[1]) / RASTER_M))
    h, w = pocket.shape
    return 0 <= gx < w and 0 <= gy < h and bool(pocket[gy, gx])


# =========================================================================================
# anchor sweep (all rooms)
# =========================================================================================
def buried_in_wall(p: Point, walls: Sequence[Segment]) -> Optional[int]:
    """Index of a wall this point is buried inside, or None.

    "Buried" = the nearest point on that wall is INTERIOR to the wall's own span (not an
    endpoint) and the perpendicular distance is under half the rendered 0.15 m thickness.
    """
    for i, seg in enumerate(walls):
        u, perp = seg_point_foot(p, seg)
        if 0.0 < u < 1.0 and perp < HALF_WALL_M:
            return i
    return None


def nearest_wall(p: Point, walls: Sequence[Segment]) -> Tuple[int, float]:
    best_i, best_d = -1, math.inf
    for i, seg in enumerate(walls):
        d = seg_point_distance(p, seg)
        if d < best_d:
            best_i, best_d = i, d
    return best_i, best_d


def sweep(plan: Dict, label: str) -> None:
    walls = [(tuple(w["a"]), tuple(w["b"])) for w in plan["walls"]]
    print(f"\n=== anchor sweep ({label}) ===")
    print(
        f"{'room':<28} {'centre->wall':>13} {'#':>4} {'in wall?':>9} "
        f"{'door->wall':>11} {'#':>4} {'in wall?':>9}"
    )
    bad_centres = 0
    for room in plan["rooms"]:
        c = tuple(room["center"])
        d = tuple(room["door"])
        ci, cd = nearest_wall(c, walls)
        di, dd = nearest_wall(d, walls)
        cb = buried_in_wall(c, walls)
        db = buried_in_wall(d, walls)
        if cb is not None:
            bad_centres += 1
        print(
            f"{room['name']:<28} {cd:>12.3f}m {ci:>4} "
            f"{('YES #' + str(cb)) if cb is not None else 'no':>9} "
            f"{dd:>10.3f}m {di:>4} "
            f"{('YES #' + str(db)) if db is not None else 'no':>9}"
        )
    print(f"rooms with a centre buried inside wall material: {bad_centres}")


# =========================================================================================
# overlay
# =========================================================================================
def write_overlay(path: str, plan: Dict, closing: Segment, old: Dict, new: Dict) -> None:
    img = cv2.imread(SOURCE_PNG)
    k = 10
    big = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_NEAREST)

    def q(p: Point) -> Tuple[int, int]:
        return (int(round(p[0] / PX_PER_M * k)), int(round((PY_ORIGIN - p[1] / PX_PER_M) * k)))

    for w in plan["walls"]:
        cv2.line(big, q(tuple(w["a"])), q(tuple(w["b"])), (200, 60, 60), 2)
    cv2.line(big, q(closing[0]), q(closing[1]), (0, 200, 255), 2)
    cv2.circle(big, q(tuple(old["center"])), 6, (0, 0, 255), -1)
    cv2.circle(big, q(tuple(old["door"])), 6, (0, 120, 255), 2)
    cv2.circle(big, q(tuple(new["center"])), 7, (0, 200, 0), -1)
    cv2.circle(big, q(tuple(new["door"])), 7, (255, 140, 0), -1)

    cx, cy = q(tuple(new["center"]))
    half = 24 * k
    x0, x1 = max(0, cx - half), min(big.shape[1], cx + half)
    y0, y1 = max(0, cy - half), min(big.shape[0], cy + half)
    cv2.imwrite(path, big[y0:y1, x0:x1])
    print(f"wrote overlay {path}")


# =========================================================================================
# main
# =========================================================================================
def load(path: str) -> Dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_plan(path: str, plan: Dict) -> None:
    """Byte-for-byte the existing file's serialization: indent 2, CRLF, no trailing newline.

    Verified as an exact round-trip of the untouched file, so the diff this script produces
    is only the anchor numbers it changed and nothing else in a 38 KB file.
    """
    blob = json.dumps(plan, indent=2, ensure_ascii=False).replace("\n", "\r\n").encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(blob)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write both floor-14.json copies")
    ap.add_argument("--dry-run", action="store_true", help="derive and report, write nothing")
    ap.add_argument("--sweep", action="store_true", help="audit all rooms' anchors and stop")
    ap.add_argument("--overlay", metavar="PATH", help="write a source overlay PNG")
    args = ap.parse_args()

    plan = load(PLAN_SERVER)
    walls: List[Segment] = [(tuple(w["a"]), tuple(w["b"])) for w in plan["walls"]]

    if args.sweep:
        sweep(plan, "current file")
        return 0

    sweep(plan, "BEFORE")

    room = next(r for r in plan["rooms"] if r["name"] == TARGET_ROOM)
    old = {"center": list(room["center"]), "door": list(room["door"])}
    old_center: Point = tuple(old["center"])

    # ---- which wall is the room parked on? the nearest one to the bad centre --------------
    north_i, north_d = nearest_wall(old_center, walls)
    north = walls[north_i]
    print(
        f"\n{TARGET_ROOM}: old centre {old['center']} is {north_d:.3f} m from walls[{north_i}] "
        f"a={list(north[0])} b={list(north[1])}"
    )

    # ---- stage 1: the closing line out of that wall's loose end --------------------------
    # Both ends of walls[35] are loose (nothing in walls[] attaches to either), so which end
    # the room hangs off is decided by the drawing, not by assumption: sweep a closing line
    # out of EVERY loose end and keep the one whose best heading actually runs over drawn ink.
    # A loose end with no wall drawn off it scores near zero; the room's own jamb line scores
    # most of its length.
    ink = SourceInk(SOURCE_PNG, walls)
    candidates = []
    for which in ("a", "b"):
        p = north[0] if which == "a" else north[1]
        touching = sum(
            1 for i, o in enumerate(walls) if i != north_i and seg_point_distance(p, o) <= 0.05
        )
        if touching:
            print(f"walls[{north_i}].{which} = {list(p)} is joined to {touching} wall(s), skipped")
            continue
        far_c, cov_c, samples_c = sweep_closing_line(p, walls, ink, north)
        print(
            f"loose end `{which}` = {[round(v, 3) for v in p]}: best closing line -> "
            f"{[round(v, 3) for v in far_c]}, ink coverage {cov_c * 100:.1f}%"
        )
        candidates.append((cov_c, which, p, far_c, samples_c))
    if not candidates:
        raise SystemExit(f"walls[{north_i}] has no loose end to close the room off from")
    coverage, which, origin, far, samples = max(candidates, key=lambda c: c[0])
    print(f"using loose end `{which}` (highest ink coverage)")
    closing: Segment = (origin, far)
    closing_len = math.hypot(far[0] - origin[0], far[1] - origin[1])
    print(
        f"closing line (best of {int(360 / SWEEP_STEP_DEG)} headings): "
        f"{[round(v, 3) for v in origin]} -> {[round(v, 3) for v in far]}  "
        f"len {closing_len:.3f} m, ink coverage {coverage * 100:.1f}%"
    )
    for is_ink, s, e in runs_along(samples, ink):
        print(f"    {'ink' if is_ink else 'gap'} {s:.3f} -> {e:.3f} m  ({e - s:.3f} m)")

    # ---- stage 2: the door ---------------------------------------------------------------
    new_door, door_width = door_from_runs(samples, ink, origin, far)
    print(
        f"door = midpoint of the {door_width:.3f} m drawn opening -> "
        f"[{new_door[0]:.3f}, {new_door[1]:.3f}]  "
        f"(nearest ink {ink.ink_distance_m(new_door):.3f} m away, so it is on blank paper)"
    )

    # ---- stage 3: the pocket and its best interior point ---------------------------------
    boundary = walls + [closing]
    pad = 1.0
    xs = [origin[0], far[0]] + [c for seg in (north,) for c in (seg[0][0], seg[1][0])]
    zs = [origin[1], far[1]] + [c for seg in (north,) for c in (seg[0][1], seg[1][1])]
    bbox = (min(xs) - pad, min(zs) - pad, max(xs) + pad, max(zs) + pad)

    # seed both sides of the parked-on wall; the enclosed nook is the SMALLER component
    u, _ = seg_point_foot(old_center, north)
    u = max(0.0, min(1.0, u))
    foot = (
        north[0][0] + u * (north[1][0] - north[0][0]),
        north[0][1] + u * (north[1][1] - north[0][1]),
    )
    wx, wz = north[1][0] - north[0][0], north[1][1] - north[0][1]
    wl = math.hypot(wx, wz)
    normal = (-wz / wl, wx / wl)
    results = []
    for sign in (+1.0, -1.0):
        seed = (foot[0] + sign * SEED_OFFSET_M * normal[0], foot[1] + sign * SEED_OFFSET_M * normal[1])
        pocket, porigin, cells = flood_pocket(seed, boundary, bbox)
        results.append((cells, sign, seed, pocket, porigin))
        print(f"seed {sign:+.0f} at [{seed[0]:.3f}, {seed[1]:.3f}] -> pocket {cells} cells "
              f"({cells * RASTER_M * RASTER_M:.2f} m2)")
    results = [r for r in results if r[0] > 0]
    if len(results) != 2:
        raise SystemExit("expected a free-space pocket on BOTH sides of the wall")
    cells, sign, seed, pocket, porigin = min(results, key=lambda r: r[0])
    print(f"nook = the smaller pocket (side {sign:+.0f}, {cells * RASTER_M * RASTER_M:.2f} m2)")

    new_center, clearance_all = pole_of_inaccessibility(pocket, porigin, boundary)
    _, clearance_walls = nearest_wall(new_center, walls)
    print(
        f"centre = pole of inaccessibility -> [{new_center[0]:.3f}, {new_center[1]:.3f}]  "
        f"clearance {clearance_all:.3f} m to the nook's boundary "
        f"(incl. the untraced closing line), {clearance_walls:.3f} m to walls[] alone"
    )

    # ---- verification --------------------------------------------------------------------
    assert point_in_pocket(new_center, pocket, porigin), "derived centre is not inside the nook"
    assert point_in_pocket(new_door, pocket, porigin) or seg_point_distance(
        new_door, closing
    ) < 0.02, "derived door is neither inside the nook nor on the closing line"
    assert clearance_all >= MIN_CENTER_CLEARANCE_M, (
        f"centre clearance {clearance_all:.3f} m is below the agent diameter "
        f"{MIN_CENTER_CLEARANCE_M:.2f} m"
    )
    assert buried_in_wall(new_center, walls) is None, "derived centre is inside wall material"
    assert buried_in_wall(new_door, walls) is None, "derived door is inside wall material"
    assert ink.ink_distance_m(new_door) > ON_INK_M, "derived door sits on drawn ink"
    dist, bound = door_sanity_bound(new_center, new_door, walls)
    assert dist <= bound, (
        f"roomDoorSanity would reject this pair: door is {dist:.3f} m from centre, bound {bound:.3f} m"
    )
    print(
        f"roomDoorSanity check: door is {dist:.3f} m from centre, bound {bound:.3f} m -- OK"
    )

    # float() because the pocket search runs over a numpy grid: np.float64 is not JSON
    # serializable and would also print as "np.float64(...)".
    rounded_center = [round(float(new_center[0]), 3), round(float(new_center[1]), 3)]
    rounded_door = [round(float(new_door[0]), 3), round(float(new_door[1]), 3)]
    print(f"\n{TARGET_ROOM}: center {old['center']} -> {rounded_center}")
    print(f"{TARGET_ROOM}: door   {old['door']} -> {rounded_door}")

    room["center"] = rounded_center
    room["door"] = rounded_door

    sweep(plan, "AFTER")

    if args.overlay:
        write_overlay(args.overlay, plan, closing, old, {"center": rounded_center, "door": rounded_door})

    if args.apply and not args.dry_run:
        write_plan(PLAN_SERVER, plan)
        write_plan(PLAN_CLIENT, plan)
        a = open(PLAN_SERVER, "rb").read()
        b = open(PLAN_CLIENT, "rb").read()
        assert a == b, "the two floor-14.json copies are not byte identical"
        print(f"\nwrote {PLAN_SERVER}")
        print(f"wrote {PLAN_CLIENT}")
        print(f"both copies byte identical: {len(a)} bytes")
    else:
        print("\n(dry run, nothing written)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
