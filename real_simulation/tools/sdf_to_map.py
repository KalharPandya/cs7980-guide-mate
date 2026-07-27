#!/usr/bin/env python3
"""Generate a Nav2 occupancy-grid map directly from a Gazebo world SDF.

Ground-truth map generation: parse every axis-aligned wall box (pose + size) from
the world's static models, rasterize their footprints into a .pgm + .yaml at a
chosen resolution, in the GAZEBO WORLD FRAME (so it aligns with the robot's pose
and future destination coordinates). No sim, no SLAM, no GPU — pure file parsing.

Convention (Nav2 map_server): pixel 0=occupied(black), 254=free(white), 205=unknown.
Free = cells reachable from the robot spawn by flood-fill; everything else = unknown.

Usage: python3 sdf_to_map.py <world.sdf> <out_basename> [resolution] [spawn_x] [spawn_y]
"""
import os, sys, math, collections
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image

SDF        = sys.argv[1] if len(sys.argv) > 1 else \
             '/opt/ros/jazzy/share/irobot_create_gz_bringup/worlds/maze.sdf'
OUT        = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'maps', 'maze_truth')
RES        = float(sys.argv[3]) if len(sys.argv) > 3 else 0.05
SPAWN      = (float(sys.argv[4]) if len(sys.argv) > 4 else 0.0,
             float(sys.argv[5]) if len(sys.argv) > 5 else 0.0)
MARGIN     = 0.5                       # m of border around the extent
WALL_MODELS = {'border', 'obstacles'}  # models to treat as obstacles (skip ground_plane/lights)
OCC, FREE, UNK = 0, 254, 205

def pose_xy(elem):
    """x,y from an element's first <pose> child (or 0,0)."""
    p = elem.find('pose')
    if p is None or not p.text:
        return 0.0, 0.0
    v = p.text.split()
    return float(v[0]), float(v[1])

def parse_walls(sdf):
    """Return list of (x0,x1,y0,y1) world-frame footprints for wall boxes."""
    root = ET.parse(sdf).getroot()
    world = root.find('world')
    rects, border_rects = [], []
    for model in world.findall('model'):
        name = model.get('name')
        if name not in WALL_MODELS:
            continue
        mx, my = pose_xy(model)
        for link in model.findall('link'):
            lx, ly = pose_xy(link)
            cx, cy = mx + lx, my + ly
            # first box geometry (prefer collision, else visual)
            box = None
            for tag in ('collision', 'visual'):
                for c in link.findall(tag):
                    b = c.find('geometry/box/size')
                    if b is not None and b.text:
                        box = b.text.split(); break
                if box: break
            if not box or len(box) < 2:
                continue
            sx, sy = float(box[0]), float(box[1])
            r = (cx - sx/2, cx + sx/2, cy - sy/2, cy + sy/2)
            rects.append(r)
            if name == 'border':
                border_rects.append(r)
    return rects, border_rects

def main():
    rects, border = parse_walls(SDF)
    if not rects:
        print('NO WALLS PARSED'); return
    # map extent from all walls + margin (world frame)
    min_x = min(r[0] for r in rects) - MARGIN
    max_x = max(r[1] for r in rects) + MARGIN
    min_y = min(r[2] for r in rects) - MARGIN
    max_y = max(r[3] for r in rects) + MARGIN
    W = int(math.ceil((max_x - min_x) / RES))
    H = int(math.ceil((max_y - min_y) / RES))
    grid = np.full((H, W), UNK, dtype=np.uint8)

    def cell(x, y):
        c = int((x - min_x) / RES)
        r = int((max_y - y) / RES)          # row 0 = top = max_y
        return r, c

    # stamp walls occupied (intersection test: any cell the rect touches, so 1cm walls survive)
    occ_mask = np.zeros((H, W), dtype=bool)
    for x0, x1, y0, y1 in rects:
        c0 = max(0, int((x0 - min_x) / RES)); c1 = min(W-1, int((x1 - min_x) / RES))
        r0 = max(0, int((max_y - y1) / RES)); r1 = min(H-1, int((max_y - y0) / RES))
        occ_mask[r0:r1+1, c0:c1+1] = True

    # flood-fill FREE from the spawn cell through non-wall cells
    sr, sc = cell(*SPAWN)
    free_mask = np.zeros((H, W), dtype=bool)
    if 0 <= sr < H and 0 <= sc < W and not occ_mask[sr, sc]:
        dq = collections.deque([(sr, sc)]); free_mask[sr, sc] = True
        while dq:
            r, c = dq.popleft()
            for dr, dc in ((1,0),(-1,0),(0,1),(0,-1)):
                nr, nc = r+dr, c+dc
                if 0 <= nr < H and 0 <= nc < W and not free_mask[nr,nc] and not occ_mask[nr,nc]:
                    free_mask[nr,nc] = True; dq.append((nr,nc))
    else:
        print(f'WARNING: spawn cell ({sr},{sc}) invalid/occupied; free region empty')

    grid[free_mask] = FREE
    grid[occ_mask]  = OCC   # walls last, on top of free

    # write pgm + yaml
    Image.fromarray(grid, 'L').save(OUT + '.pgm')
    with open(OUT + '.yaml', 'w') as f:
        f.write(f"image: {OUT.split('/')[-1]}.pgm\nmode: trinary\n"
                f"resolution: {RES}\norigin: [{min_x:.4f}, {min_y:.4f}, 0.0]\n"
                f"negate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.25\n")
    # viewable png (2x)
    Image.fromarray(grid, 'L').resize((W*2, H*2), Image.NEAREST).save(OUT + '.png')

    # report + verification stats
    nocc, nfree, nunk = int(occ_mask.sum()), int(free_mask.sum()), int((grid==UNK).sum())
    print(f'walls parsed: {len(rects)} (border={len(border)})')
    print(f'extent world: x[{min_x:.2f},{max_x:.2f}] y[{min_y:.2f},{max_y:.2f}]  grid {W}x{H} @ {RES}m')
    print(f'origin (yaml): [{min_x:.3f}, {min_y:.3f}]   spawn(0,0) cell=({sr},{sc}) free={free_mask[sr,sc] if 0<=sr<H and 0<=sc<W else "OOB"}')
    print(f'cells: occ={nocc} free={nfree} unknown={nunk}  free_area={nfree*RES*RES:.1f} m2')

if __name__ == '__main__':
    main()
