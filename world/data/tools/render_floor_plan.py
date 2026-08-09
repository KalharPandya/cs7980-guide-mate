#!/usr/bin/env python3
"""Top-down PNG renderer for world/data/floor-14.json.

Draws the plan the way the 3D scene extrudes it: every walls[] entry becomes a
filled rectangle at the real render thickness (world-client/src/scene/Walls.tsx
WALL_THICKNESS = 0.15 m), the walkable floor is light grey, and the core holes
are punched back out. North is up (world +z maps to screen -y).

Usage:
    python render_floor_plan.py [--plan PATH] [--out PATH] [--scale PX_PER_M]
                                [--annotate] [--defects]
"""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Any, Dict, List, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFont

Point = Tuple[float, float]

WALL_THICKNESS_M = 0.15

COL_BG = (255, 255, 255)
COL_FLOOR = (232, 232, 232)
COL_HOLE = (255, 255, 255)
COL_HOLE_EDGE = (170, 170, 170)
COL_WALL = (24, 24, 24)
COL_GLASS = (46, 132, 196)
COL_OUTLINE = (120, 120, 120)
COL_ROOM = (196, 60, 60)
COL_DOOR = (30, 150, 70)
COL_DEFECT = (235, 70, 40)


# ------------------------------------------------------------------ geometry --


def _pt(value: Sequence[float]) -> Point:
    return (float(value[0]), float(value[1]))


def wall_points(wall: Dict[str, Any]) -> Tuple[Point, Point]:
    return _pt(wall["a"]), _pt(wall["b"])


def wall_quad(wall: Dict[str, Any], thickness: float) -> List[Point]:
    """The filled footprint of one wall: a rectangle of `thickness` around a-b."""
    (ax, az), (bx, bz) = wall_points(wall)
    dx, dz = bx - ax, bz - az
    length = math.hypot(dx, dz)
    if length < 1e-9:
        half = thickness / 2.0
        return [
            (ax - half, az - half),
            (ax + half, az - half),
            (ax + half, az + half),
            (ax - half, az + half),
        ]
    nx, nz = -dz / length, dx / length
    half = thickness / 2.0
    return [
        (ax + nx * half, az + nz * half),
        (bx + nx * half, bz + nz * half),
        (bx - nx * half, bz - nz * half),
        (ax - nx * half, az - nz * half),
    ]


# -------------------------------------------------------------------- render --


class Projector:
    """World metres to image pixels, north up, uniform scale."""

    def __init__(self, bounds: Tuple[float, float, float, float], scale: float, margin: int):
        self.min_x, self.min_z, self.max_x, self.max_z = bounds
        self.scale = scale
        self.margin = margin
        self.width = int(round((self.max_x - self.min_x) * scale)) + 2 * margin
        self.height = int(round((self.max_z - self.min_z) * scale)) + 2 * margin

    def __call__(self, point: Sequence[float]) -> Tuple[float, float]:
        x, z = float(point[0]), float(point[1])
        px = self.margin + (x - self.min_x) * self.scale
        py = self.margin + (self.max_z - z) * self.scale
        return (px, py)

    def many(self, points: Sequence[Sequence[float]]) -> List[Tuple[float, float]]:
        return [self(p) for p in points]


def plan_bounds(plan: Dict[str, Any]) -> Tuple[float, float, float, float]:
    xs: List[float] = []
    zs: List[float] = []
    for point in plan["walkableOutline"]:
        xs.append(float(point[0]))
        zs.append(float(point[1]))
    for wall in plan["walls"]:
        for point in wall_points(wall):
            xs.append(point[0])
            zs.append(point[1])
    pad = 0.5
    return (min(xs) - pad, min(zs) - pad, max(xs) + pad, max(zs) + pad)


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("DejaVuSans.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render(
    plan: Dict[str, Any],
    out_path: str,
    scale: float = 26.0,
    annotate: bool = False,
    defects: Sequence[Tuple[str, Point]] = (),
    thickness: float = WALL_THICKNESS_M,
) -> str:
    margin = 24
    projector = Projector(plan_bounds(plan), scale, margin)
    # Supersample so the 0.15 m walls keep clean edges, then downsample.
    ss = 2
    image = Image.new("RGB", (projector.width * ss, projector.height * ss), COL_BG)
    draw = ImageDraw.Draw(image)

    def px(point: Sequence[float]) -> Tuple[float, float]:
        x, y = projector(point)
        return (x * ss, y * ss)

    def poly(points: Sequence[Sequence[float]]) -> List[Tuple[float, float]]:
        return [px(p) for p in points]

    draw.polygon(poly(plan["walkableOutline"]), fill=COL_FLOOR, outline=COL_OUTLINE)
    for hole in plan.get("holes", []):
        draw.polygon(poly(hole["polygon"]), fill=COL_HOLE, outline=COL_HOLE_EDGE)

    for wall in plan["walls"]:
        colour = COL_GLASS if wall.get("glass") else COL_WALL
        draw.polygon(poly(wall_quad(wall, thickness)), fill=colour)

    if annotate:
        font = _font(11 * ss)
        for room in plan.get("rooms", []):
            cx, cy = px(room["center"])
            radius = 3 * ss
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=COL_ROOM)
            draw.text((cx + 5 * ss, cy - 7 * ss), room["name"], fill=COL_ROOM, font=font)
            dx, dy = px(room["door"])
            draw.ellipse([dx - radius, dy - radius, dx + radius, dy + radius], fill=COL_DOOR)
        entrance = plan.get("entrance")
        if entrance:
            ex, ey = px(entrance["point"])
            radius = 5 * ss
            draw.ellipse(
                [ex - radius, ey - radius, ex + radius, ey + radius],
                outline=COL_DOOR,
                width=2 * ss,
            )

    for _label, point in defects:
        cx, cy = px(point)
        radius = 6 * ss
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=COL_DEFECT,
            width=2 * ss,
        )

    image = image.resize((projector.width, projector.height), Image.LANCZOS)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    image.save(out_path)
    return out_path


# ------------------------------------------------------------------- overlay --

# The source-image transform recorded in floor-14.json's own `note`:
#   world_x = (px - X0) * S,  world_z = (BH - (py - Y0)) * S
# so px = world_x / S + X0 and py = (BH + Y0) - world_z / S. Verified against the source: the
# building's ink bounding box in floor-14-plan-hires.png is exactly x 0..628, y 1..471, and
# walkableOutline's own bbox maps onto it to the pixel.
SOURCE_SCALE_M_PER_PX = 0.055644
SOURCE_X0 = 0.0
SOURCE_BH_PLUS_Y0 = 472.0


def world_to_source_px(point: Sequence[float]) -> Tuple[float, float]:
    return (
        float(point[0]) / SOURCE_SCALE_M_PER_PX + SOURCE_X0,
        SOURCE_BH_PLUS_Y0 - float(point[1]) / SOURCE_SCALE_M_PER_PX,
    )


def render_overlay(
    plan: Dict[str, Any],
    source_png: str,
    out_path: str,
    upscale: int = 2,
    thickness: float = WALL_THICKNESS_M,
) -> str:
    """Draw the rebuilt walls translucently on top of the original source drawing, so every
    rebuilt segment can be checked against the line it is supposed to be."""
    base = Image.open(source_png).convert("RGB")
    base = base.resize((base.width * upscale, base.height * upscale), Image.LANCZOS)
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    def px(point: Sequence[float]) -> Tuple[float, float]:
        x, y = world_to_source_px(point)
        return (x * upscale, y * upscale)

    for hole in plan.get("holes", []):
        draw.polygon([px(p) for p in hole["polygon"]], outline=(255, 140, 0, 220), width=2 * upscale)
    for wall in plan["walls"]:
        colour = (0, 120, 255, 130) if wall.get("glass") else (230, 30, 30, 130)
        draw.polygon([px(p) for p in wall_quad(wall, thickness)], fill=colour)
    draw.polygon([px(p) for p in plan["walkableOutline"]], outline=(0, 160, 0, 220), width=1 * upscale)

    out = Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB")
    out.save(out_path)
    return out_path


def render_side_by_side(
    plan: Dict[str, Any],
    source_png: str,
    out_path: str,
    upscale: int = 2,
    thickness: float = WALL_THICKNESS_M,
) -> str:
    """
    The source drawing and the rebuilt plan, side by side, at the SAME scale and orientation and
    framed on exactly the same world window, so the correspondence can be checked at a glance.
    Both panels are drawn through the same world-to-pixel mapping (upscale / metres-per-pixel),
    so a feature at world (x, z) lands at the same offset inside either panel.
    """
    bounds = plan_bounds(plan)
    min_x, min_z, max_x, max_z = bounds
    px_per_m = upscale / SOURCE_SCALE_M_PER_PX

    top_left = world_to_source_px((min_x, max_z))
    bottom_right = world_to_source_px((max_x, min_z))
    box = (int(top_left[0]), int(top_left[1]), int(bottom_right[0]), int(bottom_right[1]))

    source = Image.open(source_png).convert("RGB").crop(box)
    panel_w = int(round((max_x - min_x) * px_per_m))
    panel_h = int(round((max_z - min_z) * px_per_m))
    source = source.resize((panel_w, panel_h), Image.LANCZOS)

    rebuilt = Image.new("RGB", (panel_w, panel_h), COL_BG)
    draw = ImageDraw.Draw(rebuilt)

    def px(point: Sequence[float]) -> Tuple[float, float]:
        return ((float(point[0]) - min_x) * px_per_m, (max_z - float(point[1])) * px_per_m)

    draw.polygon([px(p) for p in plan["walkableOutline"]], fill=COL_FLOOR, outline=COL_OUTLINE)
    for hole in plan.get("holes", []):
        draw.polygon([px(p) for p in hole["polygon"]], fill=COL_HOLE, outline=COL_HOLE_EDGE)
    for wall in plan["walls"]:
        colour = COL_GLASS if wall.get("glass") else COL_WALL
        draw.polygon([px(p) for p in wall_quad(wall, thickness)], fill=colour)

    gutter = 24
    header = 34
    canvas = Image.new("RGB", (panel_w * 2 + gutter * 3, panel_h + header + gutter * 2), COL_BG)
    canvas.paste(source, (gutter, header + gutter))
    canvas.paste(rebuilt, (gutter * 2 + panel_w, header + gutter))
    label = ImageDraw.Draw(canvas)
    font = _font(20)
    label.text((gutter, gutter // 2), "source: floor-14-plan-hires.png", fill=(40, 40, 40), font=font)
    label.text(
        (gutter * 2 + panel_w, gutter // 2),
        f"rebuilt: floor-14.json walls[] ({len(plan['walls'])}) at {thickness:.2f} m thickness",
        fill=(40, 40, 40),
        font=font,
    )
    for x_offset in (gutter, gutter * 2 + panel_w):
        label.rectangle(
            [x_offset - 1, header + gutter - 1, x_offset + panel_w, header + gutter + panel_h],
            outline=(190, 190, 190),
        )
    canvas.save(out_path)
    return out_path


def main(argv: Sequence[str] | None = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_plan = os.path.normpath(os.path.join(here, "..", "floor-14.json"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", default=default_plan)
    parser.add_argument("--out", default=os.path.join(here, "floor-14-render.png"))
    parser.add_argument("--scale", type=float, default=26.0, help="pixels per metre")
    parser.add_argument("--annotate", action="store_true", help="draw room centers and doors")
    parser.add_argument("--source", default=os.path.normpath(os.path.join(here, "..", "source", "floor-14-plan-hires.png")))
    parser.add_argument("--overlay", default=None, help="also write walls drawn over the source drawing here")
    parser.add_argument("--side-by-side", default=None, help="also write source | rebuilt, same scale, here")
    args = parser.parse_args(argv)

    with open(args.plan, "r", encoding="utf-8") as handle:
        plan = json.load(handle)
    print(f"wrote {render(plan, args.out, scale=args.scale, annotate=args.annotate)}")
    if args.overlay:
        print(f"wrote {render_overlay(plan, args.source, args.overlay)}")
    if args.side_by_side:
        print(f"wrote {render_side_by_side(plan, args.source, args.side_by_side)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
