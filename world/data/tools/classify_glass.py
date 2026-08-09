#!/usr/bin/env python3
"""First-pass glass/solid classifier for world/data/floor-14.json.

Sets the `glass` boolean on every walls[] entry from the building's own rule:

  glass = true  when the wall separates an ENCLOSED room from an OPEN/PUBLIC area
                (an open-plan collaboration space, the central corridor/circulation
                band, or the outer facade where it fronts open space). "The
                classroom wall facing the open area is glass."
  glass = false when the wall separates two enclosed rooms from each other
                ("the ones separating the rooms themselves").
  glass = false for ALL Kitchen walls, always (explicit override).
  glass = false for any space with no door access / no room (a nook the visitor
                cannot enter is not glazed).
  glass = false for the two elevator/stair cores (service shafts) and any hole.

Method (no third-party deps, pure stdlib):
  Each wall is probed on BOTH sides. For three points along the wall (25/50/75 %)
  a sample is taken ~0.30 m off the wall on each side (perpendicular to the wall).
  Each sample is labelled by which room it sits in, using LINE-OF-SIGHT to the
  room centers: a room center is "visible" from the sample if the straight segment
  between them crosses no wall, and the sample takes the nearest visible center's
  room. The wall being classified is in the blocker set, so a sample just OUTSIDE a
  room cannot see that room's center through its own wall -- it falls through to the
  open area behind it. A sample outside the building footprint is OUTSIDE; one
  inside a core hole is HOLE. Each side's three samples are reduced by majority.

  This makes the two sides of a room->corridor wall read {room, OPEN} (glass),
  a room->room wall read {roomA, roomB} (solid), a core wall read {*, HOLE}
  (solid), and a facade backing a room read {room, OUTSIDE} (solid) while a facade
  fronting the open area reads {OPEN, OUTSIDE} (glass).

Geometry is NEVER touched: only the `glass` boolean changes and every authored
`note` is preserved. Both file copies are written byte-identical. Deterministic and
idempotent.

Usage:
    python classify_glass.py --report        # classify + print full breakdown, no write
    python classify_glass.py --dry-run       # classify + print summary, no write (default)
    python classify_glass.py --apply         # write both floor-14.json copies
"""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Any, Dict, List, Sequence, Tuple

Point = Tuple[float, float]

# Rooms that are OPEN/PUBLIC by design (little to no enclosing wall). A wall facing
# one of these fronts the open area, exactly like a wall facing the corridor.
OPEN_ROOMS = {
    "Event Space",
    "North Collaboration Space",
    "South Collaboration Space",
}

# Explicit override: every wall of these rooms is solid regardless of what it faces.
ALWAYS_SOLID_ROOMS = {"Kitchen"}

SAMPLE_OFFSET_M = 0.30       # how far off the wall each side sample sits
WALL_FRACTIONS = (0.25, 0.50, 0.75)  # where along the wall the samples are taken

# Labels used for a side that is not an enclosed/open room.
OUTSIDE = "OUTSIDE"          # outside the building footprint
HOLE = "HOLE"               # inside an elevator/stair core
OPEN = "OPEN"               # corridor / open-plan area (no enclosed room owns it)


# ----------------------------------------------------------------- geometry --


def _pt(v: Sequence[float]) -> Point:
    return (float(v[0]), float(v[1]))


def point_in_poly(x: float, z: float, poly: Sequence[Sequence[float]]) -> bool:
    """Standard ray-cast even-odd test."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, zi = float(poly[i][0]), float(poly[i][1])
        xj, zj = float(poly[j][0]), float(poly[j][1])
        if ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / (zj - zi) + xi):
            inside = not inside
        j = i
    return inside


def _orient(ax, az, bx, bz, cx, cz) -> float:
    return (bx - ax) * (cz - az) - (bz - az) * (cx - ax)


def segments_cross(p: Point, q: Point, a: Point, b: Point) -> bool:
    """True if open segment p-q properly crosses segment a-b.

    Endpoint touches are ignored (>0 strict on the p-q side) so that a sight line
    which merely grazes a wall's far endpoint is not counted as blocked; the wall
    being probed still blocks because the sight line passes through its body, not
    its endpoint.
    """
    d1 = _orient(a[0], a[1], b[0], b[1], p[0], p[1])
    d2 = _orient(a[0], a[1], b[0], b[1], q[0], q[1])
    d3 = _orient(p[0], p[1], q[0], q[1], a[0], a[1])
    d4 = _orient(p[0], p[1], q[0], q[1], b[0], b[1])
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return True
    return False


# ------------------------------------------------------------- classifier ---


class Classifier:
    def __init__(self, plan: Dict[str, Any]):
        self.plan = plan
        self.outline = [_pt(p) for p in plan["walkableOutline"]]
        self.holes = [[_pt(p) for p in h["polygon"]] for h in plan.get("holes", [])]
        self.wall_segs: List[Tuple[Point, Point]] = [
            (_pt(w["a"]), _pt(w["b"])) for w in plan["walls"]
        ]
        self.rooms = plan.get("rooms", [])
        # A room is enterable if it declares a door; a no-door space is not glazed.
        self.room_centers = [
            (r["name"], _pt(r["center"]), ("door" in r)) for r in self.rooms
        ]

    def label_point(self, x: float, z: float) -> str:
        for hole in self.holes:
            if point_in_poly(x, z, hole):
                return HOLE
        if not point_in_poly(x, z, self.outline):
            return OUTSIDE
        # Nearest room center with clear line of sight.
        best_name = None
        best_open = False
        best_d2 = float("inf")
        p = (x, z)
        for name, center, has_door in self.room_centers:
            dx, dz = center[0] - x, center[1] - z
            d2 = dx * dx + dz * dz
            if d2 >= best_d2:
                continue
            if self._blocked(p, center):
                continue
            best_d2 = d2
            best_name = name
            best_open = name in OPEN_ROOMS
        if best_name is None:
            return OPEN  # corridor: inside the building, no room center visible
        if best_open:
            return OPEN
        return best_name

    def _blocked(self, p: Point, q: Point) -> bool:
        for a, b in self.wall_segs:
            if segments_cross(p, q, a, b):
                return True
        return False

    def _side_label(self, mid_samples: List[str]) -> Tuple[str, bool]:
        """Majority label for one side, plus whether the samples disagreed."""
        counts: Dict[str, int] = {}
        for s in mid_samples:
            counts[s] = counts.get(s, 0) + 1
        # Deterministic tie-break: highest count, then label name.
        best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        mixed = len(counts) > 1
        return best, mixed

    def classify_wall(self, wall: Dict[str, Any]) -> Dict[str, Any]:
        a = _pt(wall["a"])
        b = _pt(wall["b"])
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        if length < 1e-9:
            return {
                "glass": False,
                "reason": "degenerate zero-length wall",
                "sideL": OUTSIDE,
                "sideR": OUTSIDE,
                "mixed": False,
            }
        nx, nz = -dz / length, dx / length  # unit perpendicular
        left: List[str] = []
        right: List[str] = []
        for f in WALL_FRACTIONS:
            mx = a[0] + dx * f
            mz = a[1] + dz * f
            left.append(self.label_point(mx + nx * SAMPLE_OFFSET_M, mz + nz * SAMPLE_OFFSET_M))
            right.append(self.label_point(mx - nx * SAMPLE_OFFSET_M, mz - nz * SAMPLE_OFFSET_M))
        side_l, mixed_l = self._side_label(left)
        side_r, mixed_r = self._side_label(right)
        glass, reason = self._decide(side_l, side_r)
        return {
            "glass": glass,
            "reason": reason,
            "sideL": side_l,
            "sideR": side_r,
            "mixed": mixed_l or mixed_r,
            "left_samples": left,
            "right_samples": right,
        }

    def _is_enclosed(self, label: str) -> bool:
        return label not in (OUTSIDE, HOLE, OPEN)

    def _no_door(self, label: str) -> bool:
        for name, _c, has_door in self.room_centers:
            if name == label:
                return not has_door
        return False

    def _decide(self, l: str, r: str) -> Tuple[bool, str]:
        """Glass iff EXACTLY ONE side is an enclosed enterable room and the other
        side is open/public. The building's own rule is "all walls are glass except
        the ones separating the rooms themselves", plus Kitchen/no-door overrides,
        so the OUTER FACADE (a side that is OUTSIDE the footprint) counts as open
        space: a classroom's wall facing outside is glass, exactly as the user said.
        """
        sides = {l, r}
        # 1. Kitchen (and any always-solid room) override -> solid.
        for name in ALWAYS_SOLID_ROOMS:
            if name in sides:
                return False, f"{name} override: always solid"
        # 2. Core / hole -> service shaft, solid.
        if HOLE in sides:
            return False, "faces an elevator/stair core (hole): solid"
        # 3. No-door space touched -> not glazed.
        if self._no_door(l) or self._no_door(r):
            return False, "faces a no-door space: solid"
        # 4. Glass iff EXACTLY ONE side is an enclosed enterable room and the other
        #    side is open/public. "The classroom wall facing outside/the open area is
        #    glass." OUTSIDE (the outer facade) and OPEN (corridor / open-plan) both
        #    count as the open/public side.
        enclosed = [s for s in (l, r) if self._is_enclosed(s)]
        if len(enclosed) == 2:
            if enclosed[0] == enclosed[1]:
                return False, f"interior spur inside {enclosed[0]}: solid"
            return False, f"separates {enclosed[0]} and {enclosed[1]}: solid"
        if len(enclosed) == 1:
            if OUTSIDE in sides:
                return True, f"outer facade of enclosed room {enclosed[0]} (faces outside): glass"
            return True, f"enclosed room {enclosed[0]} vs open area: glass"
        # zero enclosed rooms. A facade fronting the open corridor/collab area, or an
        # interior wall the sampling read as open on both sides. No enclosed room is
        # glazed here, and the under-glaze bias leaves an ambiguous open wall solid.
        if OUTSIDE in sides:
            return False, "outer facade fronting the open area (no enclosed room behind): solid"
        return False, "open area on both sides (no enclosed room): solid"


# ------------------------------------------------------------------- report --


def build_report(clf: Classifier, results: List[Dict[str, Any]], before: List[bool]) -> str:
    lines: List[str] = []
    walls = clf.plan["walls"]
    total = len(walls)
    glass_before = sum(1 for g in before if g)
    glass_after = sum(1 for r in results if r["glass"])
    lines.append(f"walls total: {total}")
    lines.append(f"glass before: {glass_before}")
    lines.append(f"glass after:  {glass_after}")
    lines.append("")

    # Outline-edge glass (the world-client floorGeometry test needs >= 1).
    outline_pts = {(round(p[0], 3), round(p[1], 3)) for p in clf.outline}

    def on_outline(w: Dict[str, Any]) -> bool:
        a = (round(float(w["a"][0]), 3), round(float(w["a"][1]), 3))
        b = (round(float(w["b"][0]), 3), round(float(w["b"][1]), 3))
        return a in outline_pts and b in outline_pts

    outline_glass = [i for i, w in enumerate(walls) if results[i]["glass"] and on_outline(w)]
    lines.append(f"glass walls on the walkableOutline (facade): {len(outline_glass)}")
    for i in outline_glass:
        w = walls[i]
        lines.append(f"  wall #{i} {w['a']}->{w['b']}: {results[i]['reason']}")
    lines.append("")

    # Per-room breakdown.
    lines.append("PER-ROOM breakdown (walls where the room is one side):")
    for name, center, has_door in clf.room_centers:
        tag = ""
        if name in ALWAYS_SOLID_ROOMS:
            tag = " [ALWAYS SOLID]"
        elif name in OPEN_ROOMS:
            tag = " [OPEN-PLAN]"
        elif not has_door:
            tag = " [NO DOOR]"
        lines.append(f"\n  {name}{tag}:")
        found = False
        for i, w in enumerate(walls):
            r = results[i]
            if name not in (r["sideL"], r["sideR"]):
                continue
            found = True
            other = r["sideR"] if r["sideL"] == name else r["sideL"]
            gtag = "GLASS" if r["glass"] else "solid"
            lines.append(
                f"    #{i:<2} {gtag:5} vs {other:<28} {w['a']}->{w['b']}  ({r['reason']})"
            )
        if not found:
            lines.append("    (no walls attributed -- open-plan / no enclosing wall)")

    # Kitchen confirmation.
    lines.append("")
    kitchen_walls = [
        i for i, r in enumerate(results) if "Kitchen" in (r["sideL"], r["sideR"])
    ]
    kitchen_glass = [i for i in kitchen_walls if results[i]["glass"]]
    lines.append(
        f"KITCHEN check: {len(kitchen_walls)} walls touch Kitchen, "
        f"{len(kitchen_glass)} glass -> "
        + ("ALL SOLID (correct)" if not kitchen_glass else f"NOT ALL SOLID: {kitchen_glass}")
    )

    # Core confirmation.
    core_walls = [i for i, r in enumerate(results) if HOLE in (r["sideL"], r["sideR"])]
    core_glass = [i for i in core_walls if results[i]["glass"]]
    lines.append(
        f"CORE check: {len(core_walls)} walls face a core hole, "
        f"{len(core_glass)} glass -> "
        + ("ALL SOLID (correct)" if not core_glass else f"NOT ALL SOLID: {core_glass}")
    )

    # Uncertain walls (samples along a side disagreed, or a washroom went glass).
    lines.append("")
    lines.append("UNCERTAIN walls to eyeball in the editor:")
    any_uncertain = False
    for i, r in enumerate(results):
        reasons = []
        touches = {r["sideL"], r["sideR"]}
        if r["glass"] and any("Washroom" in t for t in touches):
            reasons.append("washroom glazed by the mechanical rule (likely wants solid)")
        if not r["glass"] and {r["sideL"], r["sideR"]} <= {OPEN, OUTSIDE}:
            where = "outer facade fronting open" if OUTSIDE in touches else "open area on both sides"
            reasons.append(f"{where} -> left solid by under-glaze bias (may want glass)")
        if r["mixed"]:
            reasons.append("side samples disagreed along the wall")
        if reasons:
            any_uncertain = True
            w = walls[i]
            lines.append(
                f"  #{i:<2} {'GLASS' if r['glass'] else 'solid'} {w['a']}->{w['b']} "
                f"L={r['sideL']} R={r['sideR']}: {'; '.join(reasons)}"
            )
    if not any_uncertain:
        lines.append("  (none)")

    return "\n".join(lines)


# -------------------------------------------------------------------- write --

NOTE_SENTENCE = (
    " Wall glass flags were auto-classified as a FIRST PASS by "
    "world/data/tools/classify_glass.py (a wall is glass when it separates an "
    "enclosed room from an open/public area, solid between two enclosed rooms, "
    "and solid for every Kitchen wall, the cores, and any no-door space), intended "
    "for manual refinement in the interactive editor."
)


def serialize(plan: Dict[str, Any], original_raw_bytes: bytes) -> bytes:
    """json.dumps(indent=2) output with the source file's own line endings.

    The source file is standard json.dumps(indent=2, ensure_ascii=False) content
    with CRLF newlines and no trailing newline; reproduce that byte-for-byte so the
    only diff is the changed glass booleans and the appended note sentence.
    """
    text = json.dumps(plan, indent=2, ensure_ascii=False)
    use_crlf = b"\r\n" in original_raw_bytes
    if use_crlf:
        text = text.replace("\n", "\r\n")
    if original_raw_bytes.endswith(b"\n") and not text.endswith("\n" if not use_crlf else "\r\n"):
        text += "\r\n" if use_crlf else "\n"
    return text.encode("utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    world_json = os.path.normpath(os.path.join(here, "..", "floor-14.json"))
    client_json = os.path.normpath(
        os.path.join(here, "..", "..", "..", "world-client", "public", "data", "floor-14.json")
    )

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plan", default=world_json, help="primary floor-14.json to read")
    parser.add_argument("--twin", default=client_json, help="the world-client copy to keep identical")
    parser.add_argument("--report", action="store_true", help="print the full per-wall / per-room breakdown")
    parser.add_argument("--dry-run", action="store_true", help="classify and summarize but do not write (default)")
    parser.add_argument("--apply", action="store_true", help="write both floor-14.json copies")
    args = parser.parse_args(argv)

    with open(args.plan, "rb") as fh:
        raw = fh.read()
    plan = json.loads(raw.decode("utf-8"))

    before = [bool(w.get("glass")) for w in plan["walls"]]
    clf = Classifier(plan)
    results = [clf.classify_wall(w) for w in plan["walls"]]

    # Apply the new glass flag; touch nothing else on the wall.
    for w, r in zip(plan["walls"], results):
        w["glass"] = bool(r["glass"])

    # Append the first-pass note sentence exactly once (idempotent).
    note = plan.get("note", "")
    if "classify_glass.py" not in note:
        plan["note"] = note + NOTE_SENTENCE

    if args.report:
        print(build_report(clf, results, before))
    else:
        gb = sum(1 for g in before if g)
        ga = sum(1 for r in results if r["glass"])
        print(f"walls: {len(plan['walls'])}  glass before: {gb}  glass after: {ga}")

    if args.apply:
        out = serialize(plan, raw)
        for path in (args.plan, args.twin):
            with open(path, "wb") as fh:
                fh.write(out)
        print(f"WROTE {args.plan}")
        print(f"WROTE {args.twin}")
    else:
        print("(no write; pass --apply to write both copies)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
