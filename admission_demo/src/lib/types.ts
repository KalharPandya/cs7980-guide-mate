// Shared API contract between the broker (Vite middleware) and the UI panes.
// See docs/00-design.md section 5.

export const DESTINATIONS = [
  { id: "cafe", label: "Cafe", etaSeconds: 8 },
  { id: "library", label: "Library", etaSeconds: 12 },
  { id: "room-468", label: "Room 468", etaSeconds: 10 },
  { id: "front-desk", label: "Front desk", etaSeconds: 6 },
] as const;
export type DestinationId = (typeof DESTINATIONS)[number]["id"];

export type CheckinError = "BAD_CODE" | "STALE_CODE";
export type DispatchError =
  | "NO_SESSION"
  | "SESSION_EXPIRED"
  | "BAD_DESTINATION"
  | "RATE_LIMITED"
  | "DISPATCH_IN_PROGRESS";

export interface KioskNonceResponse {
  code: string;
  issuedAt: number; // ms epoch when this code was minted
  rotateInSeconds: number;
  serverNow: number;
}

export interface CheckinOk {
  token: string;
  sessionId: string;
  expiresAt: number;
  verifyMicros: number;
}
export interface CheckinFail {
  error: CheckinError;
  verifyMicros: number;
}

export interface DispatchOk {
  dispatchId: string;
  destinationId: DestinationId;
  etaSeconds: number;
  verifyMicros: number;
}
export interface DispatchFail {
  error: DispatchError;
  retryInSeconds?: number;
  verifyMicros: number;
}

// Broker-side event feed for the EVENT LOG panel. `kind` is derived from facts the
// broker actually has: HTTP status + the pane-declared x-demo-source header.
export type EventKind = "ok" | "blocked" | "warn";
export interface BrokerEvent {
  t: number;
  source: string;
  endpoint: string;
  verdict: string;
  micros: number;
  kind: EventKind;
}

export interface MetricsResponse {
  serverNow: number;
  counters: {
    filtered: number;
    sessionsIssued: number;
    rateLimited: number;
    dispatchesOk: number;
  };
  events: BrokerEvent[];
}
