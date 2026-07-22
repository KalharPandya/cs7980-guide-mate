import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { Point } from "../lib/types";
import { KEEP_OUTS, WAYPOINTS } from "../lib/scene";
import { pointInPolygon } from "../lib/geometry";

const LOBBY = WAYPOINTS.find((w) => w.id === "lobby")!.at;
const prefersReduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export type WalkOutcome = "reached" | "unsafe" | "failsafe" | "coasting";

export interface RobotHandle {
  walk: (
    path: Point[],
    opts: { unsafe?: boolean; jam?: { atFraction: number; l4on: boolean } },
    onDone: (o: WalkOutcome) => void
  ) => void;
  reset: () => void;
}

function pathLengths(path: Point[]) {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    seg.push(d);
    total += d;
  }
  return { seg, total };
}

function pointAlong(path: Point[], t: number, seg: number[], total: number): Point {
  if (path.length === 1 || total === 0) return path[0];
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i]) {
      const f = seg[i] === 0 ? 0 : target / seg[i];
      return {
        x: path[i].x + (path[i + 1].x - path[i].x) * f,
        y: path[i].y + (path[i + 1].y - path[i].y) * f,
      };
    }
    target -= seg[i];
  }
  return path[path.length - 1];
}

const insideKeepOut = (p: Point) => KEEP_OUTS.some((k) => pointInPolygon(p, k.polygon));

export const Robot = forwardRef<RobotHandle>((_props, ref) => {
  const [robot, setRobot] = useState<Point>(LOBBY);
  const [person, setPerson] = useState<Point>({ x: LOBBY.x - 20, y: LOBBY.y });
  const rafRef = useRef<number | null>(null);

  const stop = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  useImperativeHandle(ref, () => ({
    reset() {
      stop();
      setRobot(LOBBY);
      setPerson({ x: LOBBY.x - 20, y: LOBBY.y });
    },
    walk(path, opts, onDone) {
      stop();
      if (path.length < 2) {
        onDone("reached");
        return;
      }
      const { seg, total } = pathLengths(path);
      const durationMs = Math.max(900, total * 2.2);
      const start = performance.now();

      const settle = (t: number, outcome: WalkOutcome) => {
        const rp = pointAlong(path, t, seg, total);
        setRobot(rp);
        setPerson(pointAlong(path, Math.max(0, t - 0.07), seg, total));
        stop();
        onDone(outcome);
      };

      if (prefersReduced()) {
        // Jump to the terminal state, no tween. Still resolve the correct outcome.
        if (opts.jam) return settle(opts.jam.atFraction, opts.jam.l4on ? "failsafe" : "coasting");
        if (opts.unsafe) {
          // find first t inside a keep-out
          for (let s = 0; s <= 1.0001; s += 0.02) {
            if (insideKeepOut(pointAlong(path, s, seg, total))) return settle(s, "unsafe");
          }
          return settle(1, "unsafe");
        }
        return settle(1, "reached");
      }

      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        const rp = pointAlong(path, t, seg, total);
        setRobot(rp);
        setPerson(pointAlong(path, Math.max(0, t - 0.07), seg, total));

        if (opts.jam) {
          const jamT = opts.jam.atFraction;
          if (opts.jam.l4on && t >= jamT) return settle(jamT, "failsafe");
          if (!opts.jam.l4on && t >= Math.min(1, jamT + 0.12)) return settle(Math.min(1, jamT + 0.12), "coasting");
        } else if (opts.unsafe && insideKeepOut(rp)) {
          stop();
          onDone("unsafe");
          return;
        }

        if (t >= 1) {
          stop();
          onDone(opts.unsafe ? "unsafe" : "reached");
          return;
        }
        rafRef.current = requestAnimationFrame(frame);
      };
      rafRef.current = requestAnimationFrame(frame);
    },
  }));

  return (
    <g aria-hidden="true">
      {/* trailing person */}
      <circle cx={person.x} cy={person.y} r={6} fill="var(--color-dim)" opacity={0.85} />
      {/* robot */}
      <g transform={`translate(${robot.x} ${robot.y})`}>
        <circle r={12} fill="var(--color-accent)" />
        <circle r={4.5} fill="var(--color-bg)" />
      </g>
    </g>
  );
});

Robot.displayName = "Robot";
