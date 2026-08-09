"""Extract furniture footprints from the floor-14 source drawing into world/data/floor-14-furniture.json.

WHY THIS EXISTS
---------------
The wall geometry in floor-14.json is objectively clean now (84 walls, no duplicate pairs, no
crossings, no T-gaps), but every room still renders as an empty grey volume, so the scene reads as
a WALL DIAGRAM rather than as a building. The source drawing has furniture in essentially every
room; this script recovers it.

WHY IT IS SEPARABLE AT ALL
--------------------------
floor-14.json's own `source` note records that the wall extraction "isolates dark wall ink from
light-grey furniture" with an OpenCV intensity threshold at 180. That is the whole trick, run in
reverse: the drawing is a two-tone line drawing where structure (walls, doors, room labels, the
washroom pictograms) is near-black ink and furniture is a much lighter grey line weight. So the
same threshold that defined "wall" defines "not wall", and the band just above it is furniture.

WHAT THIS DOES *NOT* TOUCH
--------------------------
It never reads or writes floor-14.json. That file is deployed, schema-validated server-side, and
asserted by tests; furniture is emitted to its own file so the two can never interfere. The output
is RENDER-ONLY data (see Furniture.tsx) and is deliberately absent from the navmesh build.

Run: python world/data/tools/extract_furniture.py [--overlay out.png]
"""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Iterable

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Geometry: the image/meters transform recorded in floor-14.json's `source` note.
# px = x / PIXELS_TO_METERS, py = PIXEL_Y_ORIGIN - z / PIXELS_TO_METERS
# ---------------------------------------------------------------------------
PIXELS_TO_METERS = 0.055644
PIXEL_Y_ORIGIN = 472

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SOURCE_IMAGE = os.path.join(REPO_ROOT, "world", "data", "source", "floor-14-plan-hires.png")
FLOOR_PLAN = os.path.join(REPO_ROOT, "world", "data", "floor-14.json")
OUTPUT = os.path.join(REPO_ROOT, "world", "data", "floor-14-furniture.json")
# The browser build serves its own copy out of public/, exactly like floor-14.json does (see
# world-client/src/net/useFloorPlan.ts). floor-14.json's two copies are kept in step by hand and
# guarded by a byte-comparison test because a human edits that file; nobody hand-edits this one, so
# the cheaper and stricter answer is for the generator to write both copies itself and leave no
# window in which they can differ.
CLIENT_OUTPUT = os.path.join(REPO_ROOT, "world-client", "public", "data", "floor-14-furniture.json")

# ---------------------------------------------------------------------------
# Thresholds. Every one of these was tuned by rendering the resulting mask over the source
# drawing and looking at it, not guessed; the justification is recorded next to each.
# ---------------------------------------------------------------------------

# Anything darker than this is structural ink: walls, door swings, room labels, the washroom
# pictograms, the "Northeastern University" wordmark. Exactly the constant the wall extraction
# used, restated here rather than re-derived, so "furniture" is by construction the complement of
# "wall" and the two passes can never disagree about a pixel.
WALL_INK_MAX = 180

# Upper end of the furniture band. Measured, not guessed: sampling the light-grey line work per
# room gives a median of ~234 in Classroom 1426 but ~245/246 in the South Collaboration Space and
# the Quiet Study Space, which are drawn at a noticeably lighter line weight. A ceiling of 235
# therefore silently loses two entire rooms' worth of furniture. Pushing past ~248 starts pulling
# in the paper-white antialiasing gradient itself (component count jumps from ~170 to ~500 while
# the pixel count barely moves, i.e. pure speckle), so 247 is the last value that still gains real
# furniture rather than noise.
FURNITURE_MAX = 247

# Dark ink is antialiased, so every wall and every text glyph is wrapped in a one-to-three pixel
# fringe that lands squarely inside the furniture band. Growing the ink mask by this many 3x3
# dilations before subtracting it removes those fringes. Three iterations, not one: at one or two
# a visible hairline survives along the long exterior walls and would be emitted as a 5m "table"
# lying on the wall. This is also what removes TEXT for free -- room labels are black ink, so the
# glyphs are in the ink mask and their halos are in its dilation, and no text-shape heuristic is
# needed at all.
INK_HALO_DILATIONS = 3

# The light-grey strokes are thin enough that antialiasing breaks them into dashes, so a closing
# is needed to rejoin one desk's own outline before connected-component labelling. The kernel SIZE
# is the whole ballgame and was decided by looking at Classroom 1425, the densest desk field on the
# plan: with a 3x3 kernel the entire field collapses into 2 components and the room renders as one
# 3.7m slab; with no closing at all the field separates correctly into ~20 desks but the two
# lightest-drawn rooms (Quiet Study, South Collaboration) fragment into sub-noise-floor specks and
# lose most of their furniture. A 2x2 kernel bridges the one-pixel antialiasing dashes without
# reaching across the several-pixel gap the drawing leaves between neighbouring desks: 93 items,
# desk-level granularity in 1425, and Quiet Study still covered.
STROKE_CLOSE_KERNEL = np.ones((2, 2), np.uint8)

# --- component filters ---------------------------------------------------------------------
# Fewer than this many pixels is a speck of antialiasing, not a drawn object.
MIN_COMPONENT_AREA_PX = 8
# ~3.6px. Below this nothing in the drawing is a distinguishable object.
MIN_LONG_SIDE_M = 0.20
# The whole floor plate is ~35m across. Anything longer than this is a leak, not a piece of
# furniture; nothing legitimate in this drawing comes close.
MAX_LONG_SIDE_M = 8.0
# Under ~2px wide. A real drawn object always has two strokes and therefore some width; a
# sub-2px-wide sliver is a surviving antialiasing fringe.
MIN_SHORT_SIDE_M = 0.10

# --- over-merged component splitting -------------------------------------------------------
# The closing kernel above is a single global compromise and two places on the plan lose it:
# Classroom 1425's middle pair of desk rows fuse into one 3.56 x 2.16m block, and the South
# Collaboration Space's booth field fuses into one 3.76 x 3.43m block. A bigger kernel makes 1425
# worse and a smaller one starves the lightly-drawn rooms, so no single kernel can win and the
# repair has to happen after labelling, on the components that are actually wrong.
#
# WHICH COMPONENTS ARE ACTUALLY WRONG: measured, not assumed. Sorting every component by the SHORT
# side of its oriented box gives 3.434m, 2.155m, then 1.391m and a dense tail below that. Nothing
# on this plan is a single object more than ~1.4m across its short axis (that tail is round tables
# and single desks-with-chair), so the population itself hands us the cut point: a gate anywhere in
# (1.40, 2.15) selects exactly the two known slabs and nothing else. 1.50 sits in that gap with
# room on both sides. Fill ratio was tried first and rejected: everything here is hollow line work,
# so fill ratio just tracks size (0.26 for the slabs but also 0.12 for a perfectly good single
# item) and does not separate the two populations.
SPLIT_MIN_SHORT_SIDE_M = 1.50

# A cut is only made where the drawing shows a GAP, i.e. a bin of the 1px density profile whose
# count is a small fraction of the typical density on both sides of it. Measured on the two slabs:
# 1425's row separation scores 0.17, and South Collaboration's two booth-column gaps score 0.30 and
# 0.32. The deepest *interior* dip in the piece that is left over after those cuts scores 0.50, and
# that piece is genuinely two rows of booths drawn back to back sharing one line, so there is no
# gap there to find. 0.35 is therefore the only band that takes every real gap and invents none.
SPLIT_VALLEY_RATIO = 0.35

# Both cut-side margins, in pixels (~0.33m). Keeps a cut from shaving a sliver off one end, and
# means the median density used to normalise the valley is computed over a meaningful run.
SPLIT_MIN_PIECE_PX = 6

# Recursion bound. In practice the deepest chain observed is 2 (South Collaboration), so this is
# purely a guarantee that the routine terminates on unexpected input.
SPLIT_MAX_DEPTH = 4

# --- rendered heights ----------------------------------------------------------------------
# Two tiers only, chosen from footprint size, because the drawing itself only distinguishes two
# kinds of thing: seats and the surfaces they sit at. Both stay far below the 2.1m partitions so
# furniture can never be confused for a wall.
SEAT_MAX_LONG_SIDE_M = 0.70
SEAT_HEIGHT_M = 0.45
TABLE_HEIGHT_M = 0.75


def load_floor_plan() -> dict:
    with open(FLOOR_PLAN, "r", encoding="utf-8") as fh:
        return json.load(fh)


def point_in_polygon(x: float, z: float, polygon: Iterable[Iterable[float]]) -> bool:
    """Standard ray-cast test. Used for the walkableOutline (keep) and holes (reject) tests."""
    pts = list(polygon)
    inside = False
    n = len(pts)
    for i in range(n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        if (z0 > z) != (z1 > z):
            t = (z - z0) / (z1 - z0)
            if x < x0 + t * (x1 - x0):
                inside = not inside
    return inside


def px_to_m(px: float, py: float) -> tuple[float, float]:
    return px * PIXELS_TO_METERS, (PIXEL_Y_ORIGIN - py) * PIXELS_TO_METERS


def build_furniture_mask(image_bgr: np.ndarray) -> np.ndarray:
    """Binary mask of light-grey furniture line work, with structural ink and its halo removed."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    ink = (gray < WALL_INK_MAX).astype(np.uint8)
    ink_halo = cv2.dilate(ink, np.ones((3, 3), np.uint8), iterations=INK_HALO_DILATIONS)
    band = ((gray >= WALL_INK_MAX) & (gray < FURNITURE_MAX)).astype(np.uint8)
    mask = band & (1 - ink_halo)
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, STROKE_CLOSE_KERNEL)


def rect_axes(rect) -> tuple[np.ndarray, np.ndarray]:
    """Unit vectors along the (long, short) sides of a minAreaRect.

    Taken from the rect's own corner points rather than from its angle, for the same reason the
    emitted `axis` is: OpenCV's angle convention changed between 4.5 and 5.x and the corners did
    not.
    """
    box = cv2.boxPoints(rect)
    e0, e1 = box[1] - box[0], box[2] - box[1]
    n0, n1 = float(np.hypot(*e0)), float(np.hypot(*e1))
    if n0 >= n1:
        return e0 / (n0 or 1.0), e1 / (n1 or 1.0)
    return e1 / (n1 or 1.0), e0 / (n0 or 1.0)


def find_valley_cut(pts: np.ndarray, rect) -> tuple[np.ndarray, float] | None:
    """Deepest density valley across a component's own two principal axes, or None.

    Projects the component's pixels onto each axis of its oriented box and histograms them at one
    bin per pixel. A furniture-to-furniture boundary shows up as a bin whose count collapses
    relative to the line work on either side, so each interior bin is scored as
    count / min(median density left, median density right). Normalising by the SMALLER of the two
    sides is the conservative choice: it demands that both neighbours be genuinely denser than the
    dip, so a thin tail hanging off one end of a component cannot masquerade as a gap.
    """
    centre = np.array(rect[0], np.float32)
    best: tuple[float, np.ndarray, float] | None = None
    for axis in rect_axes(rect):
        t = (pts - centre) @ axis
        lo = float(t.min())
        bins = int(math.ceil(float(t.max()) - lo)) + 1
        if bins < 2 * SPLIT_MIN_PIECE_PX + 3:
            continue
        hist, _ = np.histogram(t, bins=bins, range=(lo, lo + bins))
        for i in range(SPLIT_MIN_PIECE_PX, bins - SPLIT_MIN_PIECE_PX):
            denom = min(float(np.median(hist[:i])), float(np.median(hist[i + 1 :])))
            if denom <= 0:
                continue
            ratio = float(hist[i]) / denom
            if best is None or ratio < best[0]:
                best = (ratio, axis, lo + i + 0.5)
    if best is None or best[0] > SPLIT_VALLEY_RATIO:
        return None
    return best[1], best[2]


def connected_pieces(pts: np.ndarray) -> list[np.ndarray]:
    """Re-label a loose pixel set into its connected pieces.

    Run on each half after a cut, because removing one row of pixels frequently severs bridges
    elsewhere in that half. Without this a half that has fallen into two disjoint clumps would get
    a single bounding box spanning the empty space between them.
    """
    mn = pts.min(axis=0).astype(np.int32)
    mx = pts.max(axis=0).astype(np.int32)
    sub = np.zeros((int(mx[1] - mn[1]) + 1, int(mx[0] - mn[0]) + 1), np.uint8)
    idx = pts.astype(np.int32) - mn
    sub[idx[:, 1], idx[:, 0]] = 1
    count, labels = cv2.connectedComponents(sub, 8)
    out = []
    for i in range(1, count):
        ys, xs = np.nonzero(labels == i)
        out.append(np.column_stack((xs + mn[0], ys + mn[1])).astype(np.float32))
    return out


def split_over_merged(pts: np.ndarray, depth: int = 0) -> list[np.ndarray]:
    """Cut an implausibly wide component apart at the gaps the drawing actually shows.

    Only components wider than SPLIT_MIN_SHORT_SIDE_M across their short axis are considered at
    all, and each cut needs its own evidence (see find_valley_cut), so a genuinely solid table is
    left alone: no valley, no cut. The size gate is re-tested on every piece, which is what stops
    the recursion from shredding a correctly-sized result that happens to still contain a dip.
    """
    rect = cv2.minAreaRect(pts)
    if min(rect[1]) * PIXELS_TO_METERS <= SPLIT_MIN_SHORT_SIDE_M or depth >= SPLIT_MAX_DEPTH:
        return [pts]
    cut = find_valley_cut(pts, rect)
    if cut is None:
        return [pts]
    axis, offset = cut
    t = (pts - np.array(rect[0], np.float32)) @ axis
    halves = (pts[t < offset], pts[t >= offset])
    if min(len(halves[0]), len(halves[1])) < MIN_COMPONENT_AREA_PX:
        return [pts]
    out: list[np.ndarray] = []
    for half in halves:
        for piece in connected_pieces(half):
            out.extend(split_over_merged(piece, depth + 1))
    return out


def segment_intersects_rect(a: tuple, b: tuple, corners: np.ndarray) -> bool:
    """True if segment a-b touches the (possibly rotated) rectangle given by its four corners.

    Only used for the reporting statistic "how many items overlap a wall centreline", which is a
    quality signal about the extraction, not a filter.
    """

    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    def seg_hit(p1, p2, p3, p4):
        d1, d2 = side(p3, p4, p1), side(p3, p4, p2)
        d3, d4 = side(p1, p2, p3), side(p1, p2, p4)
        return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))

    for i in range(4):
        if seg_hit(a, b, corners[i], corners[(i + 1) % 4]):
            return True
    # Fully-contained segment: no edge crossing, so test one endpoint against the rectangle.
    return point_in_polygon(a[0], a[1], corners)


def extract(image_bgr: np.ndarray, plan: dict) -> tuple[list[dict], dict]:
    mask = build_furniture_mask(image_bgr)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)

    outline = plan["walkableOutline"]
    holes = [h["polygon"] for h in plan["holes"]]

    items: list[dict] = []
    rejected = {"tiny": 0, "sliver": 0, "oversize": 0, "outside_outline": 0, "in_hole": 0}
    split_stats = {"components_split": 0, "pieces_from_splits": 0}

    def emit(pts: np.ndarray) -> None:
        """Measure one pixel set, apply every size/containment filter, and append an item."""
        (cx_px, cy_px), (w_px, h_px), angle_deg = cv2.minAreaRect(pts)
        long_px, short_px = max(w_px, h_px), min(w_px, h_px)
        long_m = long_px * PIXELS_TO_METERS
        short_m = short_px * PIXELS_TO_METERS

        if len(pts) < MIN_COMPONENT_AREA_PX or long_m < MIN_LONG_SIDE_M:
            rejected["tiny"] += 1
            return
        if short_m < MIN_SHORT_SIDE_M:
            rejected["sliver"] += 1
            return
        if long_m > MAX_LONG_SIDE_M:
            rejected["oversize"] += 1
            return

        cx_m, cz_m = px_to_m(cx_px, cy_px)

        if any(point_in_polygon(cx_m, cz_m, hole) for hole in holes):
            rejected["in_hole"] += 1
            return
        if not point_in_polygon(cx_m, cz_m, outline):
            rejected["outside_outline"] += 1
            return

        # Long-axis direction, taken from minAreaRect's own corner points rather than from its
        # angle convention (which changed between OpenCV 4.5 and 5.x). Image y grows DOWNWARD
        # while floor-plan z grows upward, so the y component is negated on the way out; the
        # renderer then feeds this straight to floorPlanUtils.directionToYRotation, the same
        # helper Walls.tsx uses, so furniture and walls can never disagree about what a heading
        # means.
        box = cv2.boxPoints(((cx_px, cy_px), (w_px, h_px), angle_deg))
        e0 = box[1] - box[0]
        e1 = box[2] - box[1]
        axis = e0 if np.hypot(*e0) >= np.hypot(*e1) else e1
        axis_len = float(np.hypot(*axis)) or 1.0
        axis_x = float(axis[0]) / axis_len
        axis_z = float(-axis[1]) / axis_len

        items.append(
            {
                "center": [round(cx_m, 3), round(cz_m, 3)],
                "size": [round(long_m, 3), round(short_m, 3)],
                "axis": [round(axis_x, 4), round(axis_z, 4)],
                "height": SEAT_HEIGHT_M if long_m <= SEAT_MAX_LONG_SIDE_M else TABLE_HEIGHT_M,
            }
        )

    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] < MIN_COMPONENT_AREA_PX:
            rejected["tiny"] += 1
            continue

        # Crop to the component's own bbox before extracting points: labels is full-frame and a
        # whole-image scan per component would be 160 passes over 311k pixels for no reason.
        x0 = stats[label, cv2.CC_STAT_LEFT]
        y0 = stats[label, cv2.CC_STAT_TOP]
        w = stats[label, cv2.CC_STAT_WIDTH]
        h = stats[label, cv2.CC_STAT_HEIGHT]
        ys, xs = np.nonzero(labels[y0 : y0 + h, x0 : x0 + w] == label)
        pts = np.column_stack((xs + x0, ys + y0)).astype(np.float32)

        pieces = split_over_merged(pts)
        if len(pieces) > 1:
            split_stats["components_split"] += 1
            split_stats["pieces_from_splits"] += len(pieces)
        for piece in pieces:
            emit(piece)

    # Sorted for a stable, diffable file: re-running the script on an unchanged image must not
    # reshuffle the JSON just because OpenCV's label order shifted.
    items.sort(key=lambda it: (it["center"][0], it["center"][1]))

    stats_out = {
        "components": count - 1,
        "kept": len(items),
        "rejected": rejected,
        "split": split_stats,
    }
    return items, stats_out


def placement_report(items: list[dict], plan: dict) -> dict:
    """Sanity numbers: these are reported, not enforced (the filters above already enforce)."""
    outline = plan["walkableOutline"]
    holes = [h["polygon"] for h in plan["holes"]]

    inside = 0
    for it in items:
        cx, cz = it["center"]
        if point_in_polygon(cx, cz, outline) and not any(point_in_polygon(cx, cz, h) for h in holes):
            inside += 1

    on_wall = 0
    for it in items:
        cx, cz = it["center"]
        (lx, lz) = it["axis"]
        long_m, short_m = it["size"]
        # Rebuild the oriented rectangle's corners in meters from center/size/axis.
        ux, uz = lx * long_m / 2, lz * long_m / 2
        vx, vz = -lz * short_m / 2, lx * short_m / 2
        corners = np.array(
            [
                [cx + ux + vx, cz + uz + vz],
                [cx + ux - vx, cz + uz - vz],
                [cx - ux - vx, cz - uz - vz],
                [cx - ux + vx, cz - uz + vz],
            ]
        )
        if any(segment_intersects_rect(tuple(w["a"]), tuple(w["b"]), corners) for w in plan["walls"]):
            on_wall += 1

    return {"insideOutlineAndOutsideHoles": inside, "overlapsWallCentreline": on_wall}


def write_overlay(path: str, image_bgr: np.ndarray, items: list[dict]) -> None:
    vis = image_bgr.copy()
    for it in items:
        cx, cz = it["center"]
        lx, lz = it["axis"]
        long_m, short_m = it["size"]
        ux, uz = lx * long_m / 2, lz * long_m / 2
        vx, vz = -lz * short_m / 2, lx * short_m / 2
        pts = []
        for sx, sv in ((1, 1), (1, -1), (-1, -1), (-1, 1)):
            mx = cx + sx * ux + sv * vx
            mz = cz + sx * uz + sv * vz
            pts.append([int(round(mx / PIXELS_TO_METERS)), int(round(PIXEL_Y_ORIGIN - mz / PIXELS_TO_METERS))])
        color = (0, 140, 255) if it["height"] == SEAT_HEIGHT_M else (0, 0, 255)
        cv2.polylines(vis, [np.array(pts, np.int32)], True, color, 1)
    cv2.imwrite(path, cv2.resize(vis, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--overlay", help="also write a debug PNG of the extracted boxes over the source drawing")
    ap.add_argument("--dry-run", action="store_true", help="report only, do not write the JSON")
    args = ap.parse_args()

    image = cv2.imread(SOURCE_IMAGE, cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"could not read {SOURCE_IMAGE}")
    plan = load_floor_plan()

    items, stats = extract(image, plan)
    report = placement_report(items, plan)

    print(f"components: {stats['components']}")
    print(f"kept:       {stats['kept']}")
    print(f"rejected:   {stats['rejected']}")
    print(f"split:      {stats['split']}")
    print(f"inside walkableOutline and outside both holes: {report['insideOutlineAndOutsideHoles']}/{len(items)}")
    print(f"overlapping a wall centreline:                 {report['overlapsWallCentreline']}/{len(items)}")
    seats = sum(1 for it in items if it["height"] == SEAT_HEIGHT_M)
    print(f"seat-height items: {seats}, table-height items: {len(items) - seats}")

    if args.overlay:
        write_overlay(args.overlay, image, items)
        print(f"overlay written to {args.overlay}")

    if args.dry_run:
        return

    payload = {
        "units": "meters",
        "floor": 14,
        "source": (
            "Algorithmically extracted from world/data/source/floor-14-plan-hires.png by "
            "world/data/tools/extract_furniture.py. The drawing is two-tone: structural ink "
            f"(walls, doors, room labels, pictograms) is darker than {WALL_INK_MAX}, furniture is "
            f"light-grey line work in [{WALL_INK_MAX}, {FURNITURE_MAX}). The ink mask is dilated "
            f"{INK_HALO_DILATIONS}x before subtraction to remove antialiasing fringes around walls "
            "and text glyphs, which is also what excludes room labels and the university wordmark "
            "without any text-shape heuristic. Remaining line work is closed, connected-component "
            "labelled, and reduced to one oriented bounding box per component. A component whose "
            f"short axis exceeds {SPLIT_MIN_SHORT_SIDE_M}m is too wide to be one piece of "
            "furniture, so it is cut apart at the density valleys visible along its own principal "
            "axes (a cut is only made where the drawing shows a real gap). Components are "
            "dropped if too small, sub-2px thin, longer than "
            f"{MAX_LONG_SIDE_M}m, centred inside an elevator/stair core hole, or centred outside "
            "walkableOutline. RENDER-ONLY: this file is never fed to the navmesh build."
        ),
        "note": (
            "One oriented box per furniture component. `center` is [x, z] in floor-plan meters, "
            "`size` is [longSide, shortSide], `axis` is a unit vector along the long side in "
            "floor-plan coordinates (feed it to directionToYRotation), `height` is the rendered "
            "extrusion height."
        ),
        "items": items,
    }
    for path in (OUTPUT, CLIENT_OUTPUT):
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        print(f"wrote {path} ({len(items)} items)")


if __name__ == "__main__":
    main()
