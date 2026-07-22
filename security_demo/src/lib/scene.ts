import type { Point } from "./types";

// Virtual floor scene (docs/03-architecture.md section 5). This same data is the
// TRUSTED reference map that L3 checks paths against. SVG logical coords, viewBox 0 0 800 560.

export const VIEWBOX = { w: 800, h: 560 };

export interface Waypoint {
  id: string;
  label: string;
  at: Point;
}

// Safe destinations. These, and only these, populate the L2 enum and the L3 allowlist.
export const WAYPOINTS: Waypoint[] = [
  { id: "lobby", label: "Lobby (start)", at: { x: 120, y: 460 } },
  { id: "reception", label: "Reception", at: { x: 120, y: 130 } },
  { id: "office", label: "Office", at: { x: 380, y: 130 } },
  { id: "cafe", label: "Cafe", at: { x: 300, y: 380 } },
  { id: "meeting_rm", label: "Meeting Rm", at: { x: 500, y: 380 } },
  { id: "balcony", label: "Balcony", at: { x: 700, y: 300 } },
];

export const SAFE_DESTINATIONS = WAYPOINTS.map((w) => w.id).filter((id) => id !== "lobby");

// The closed enum handed to the model at L2 (strict tool use). Physically bounds the output.
export const DESTINATION_ENUM = ["lobby", "reception", "cafe", "office", "meeting_rm", "balcony"];

export interface KeepOut {
  id: string;
  label: string;
  polygon: Point[];
  centroid: Point;
}

// Keep-out zones. NOT in the enum. The Stairwell sits on the Meeting Rm -> Balcony leg,
// which is the crux of the "valid destination, unsafe path" scenario: only L3 catches it.
export const KEEP_OUTS: KeepOut[] = [
  {
    id: "stairwell",
    label: "Stairwell",
    polygon: [
      { x: 560, y: 300 },
      { x: 660, y: 300 },
      { x: 660, y: 388 },
      { x: 560, y: 388 },
    ],
    centroid: { x: 610, y: 344 },
  },
  {
    id: "server_rm",
    label: "Server Rm",
    polygon: [
      { x: 470, y: 90 },
      { x: 560, y: 90 },
      { x: 560, y: 175 },
      { x: 470, y: 175 },
    ],
    centroid: { x: 515, y: 132 },
  },
];

// Edges drawn as the corridor graph (visual context on the map).
export const EDGES: [string, string][] = [
  ["lobby", "cafe"],
  ["lobby", "reception"],
  ["reception", "office"],
  ["cafe", "meeting_rm"],
  ["meeting_rm", "balcony"],
];

const byId = (id: string) => WAYPOINTS.find((w) => w.id === id)!;

// Fixed routes for the demo graph. Resolves waypoint ids (and keep-out targets) to
// pixel polylines the robot follows. Keep-out targets route the robot toward the zone
// centroid so the walk visibly enters the forbidden area.
const ROUTES: Record<string, string[]> = {
  cafe: ["lobby", "cafe"],
  reception: ["lobby", "reception"],
  office: ["lobby", "reception", "office"],
  meeting_rm: ["lobby", "cafe", "meeting_rm"],
  balcony: ["lobby", "cafe", "meeting_rm", "balcony"],
  lobby: ["lobby"],
};

export function resolvePath(destinationId: string): Point[] {
  // Safe / known waypoint destination.
  if (ROUTES[destinationId]) return ROUTES[destinationId].map((id) => byId(id).at);

  // Keep-out target (e.g. "stairwell", "stairwell_top", "server_rm"). Route via the
  // nearest reachable waypoint, then into the zone centroid.
  const ko = KEEP_OUTS.find((k) => destinationId.includes(k.id) || k.id.includes(destinationId));
  if (ko) {
    if (ko.id === "stairwell") {
      return [byId("lobby").at, byId("cafe").at, byId("meeting_rm").at, ko.centroid];
    }
    return [byId("lobby").at, byId("reception").at, ko.centroid];
  }
  return [];
}

export function isKeepOutTarget(destinationId: string | null): string | null {
  if (!destinationId) return null;
  const ko = KEEP_OUTS.find((k) => destinationId.includes(k.id) || k.id.includes(destinationId));
  return ko ? ko.id : null;
}
