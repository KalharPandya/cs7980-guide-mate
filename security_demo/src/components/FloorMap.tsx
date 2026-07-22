import type { ReactNode, RefObject } from "react";
import type { Point } from "../lib/types";
import { EDGES, KEEP_OUTS, VIEWBOX, WAYPOINTS } from "../lib/scene";
import { Robot, type RobotHandle } from "./Robot";

const wp = (id: string) => WAYPOINTS.find((w) => w.id === id)!;

export function FloorMap({
  robotRef,
  path,
  danger,
  statusPill,
}: {
  robotRef: RefObject<RobotHandle>;
  path: Point[];
  danger: boolean;
  statusPill?: ReactNode;
}) {
  const pathStr = path.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <div className="relative">
      {statusPill && <div className="absolute right-3 top-3 z-10">{statusPill}</div>}
      <svg
        viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`}
        className="h-auto w-full rounded-[var(--radius-core)]"
        style={{ background: "var(--color-bg)" }}
        role="img"
        aria-label="Floor map showing waypoints, two keep-out zones (Stairwell and Server Rm), the planned path, and the robot leading a person."
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="var(--color-line)" strokeWidth="1" opacity="0.5" />
          </pattern>
          <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--color-danger)" strokeWidth="1.4" opacity="0.55" />
          </pattern>
        </defs>

        <rect x="0" y="0" width={VIEWBOX.w} height={VIEWBOX.h} fill="url(#grid)" />

        {/* corridor graph */}
        {EDGES.map(([a, b]) => (
          <line
            key={`${a}-${b}`}
            x1={wp(a).at.x}
            y1={wp(a).at.y}
            x2={wp(b).at.x}
            y2={wp(b).at.y}
            stroke="var(--color-line)"
            strokeWidth="6"
            strokeLinecap="round"
          />
        ))}

        {/* keep-out zones */}
        {KEEP_OUTS.map((ko) => {
          const pts = ko.polygon.map((p) => `${p.x},${p.y}`).join(" ");
          return (
            <g key={ko.id}>
              <polygon points={pts} fill="url(#hatch)" stroke="var(--color-danger)" strokeWidth="1.5" opacity="0.9" />
              <text
                x={ko.centroid.x}
                y={ko.centroid.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="12"
                fontFamily="var(--font-mono)"
                fill="var(--color-danger)"
              >
                {ko.label}
              </text>
            </g>
          );
        })}

        {/* planned path */}
        {path.length >= 2 && (
          <polyline
            points={pathStr}
            fill="none"
            stroke={danger ? "var(--color-danger)" : "var(--color-accent)"}
            strokeWidth="3"
            strokeDasharray="2 7"
            strokeLinecap="round"
          />
        )}

        {/* waypoints */}
        {WAYPOINTS.map((w) => {
          const isStart = w.id === "lobby";
          return (
            <g key={w.id}>
              <circle
                cx={w.at.x}
                cy={w.at.y}
                r={isStart ? 7 : 5}
                fill={isStart ? "var(--color-accent)" : "var(--color-elevated)"}
                stroke="var(--color-dim)"
                strokeWidth="1.5"
              />
              <text
                x={w.at.x + 12}
                y={w.at.y + 4}
                fontSize="12.5"
                fontFamily="var(--font-mono)"
                fill="var(--color-dim)"
              >
                {w.label}
              </text>
            </g>
          );
        })}

        <Robot ref={robotRef} />
      </svg>
    </div>
  );
}
