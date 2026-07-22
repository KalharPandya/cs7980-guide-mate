import type { Point } from "./types";
import type { KeepOut } from "./scene";

// L3 core: does a planned path cross any keep-out polygon? Pure functions, unit-testable,
// decoupled from the demo scene. See docs/03-architecture.md section 5.4.

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersects =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function orient(a: Point, b: Point, c: Point): number {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : 2;
}

function onSeg(a: Point, b: Point, c: Point): boolean {
  return (
    Math.min(a.x, c.x) <= b.x &&
    b.x <= Math.max(a.x, c.x) &&
    Math.min(a.y, c.y) <= b.y &&
    b.y <= Math.max(a.y, c.y)
  );
}

export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(p1, p3, p2)) return true;
  if (o2 === 0 && onSeg(p1, p4, p2)) return true;
  if (o3 === 0 && onSeg(p3, p1, p4)) return true;
  if (o4 === 0 && onSeg(p3, p2, p4)) return true;
  return false;
}

export interface PathHit {
  polygonId: string;
  segmentIndex: number;
}

export function pathHitsKeepOut(path: Point[], keepOuts: KeepOut[]): PathHit | null {
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    for (const ko of keepOuts) {
      // endpoint inside the zone, or the segment crosses any polygon edge
      if (pointInPolygon(a, ko.polygon) || pointInPolygon(b, ko.polygon)) {
        return { polygonId: ko.id, segmentIndex: i };
      }
      for (let e = 0, f = ko.polygon.length - 1; e < ko.polygon.length; f = e++) {
        if (segmentsIntersect(a, b, ko.polygon[e], ko.polygon[f])) {
          return { polygonId: ko.id, segmentIndex: i };
        }
      }
    }
  }
  return null;
}

// Measure the check with a high-resolution timer. performance.now() is available in both
// Node (broker) and the browser. Returns microseconds.
export function timedPathCheck(
  path: Point[],
  keepOuts: KeepOut[]
): { hit: PathHit | null; micros: number } {
  const start = performance.now();
  const hit = pathHitsKeepOut(path, keepOuts);
  const micros = (performance.now() - start) * 1000;
  return { hit, micros };
}
