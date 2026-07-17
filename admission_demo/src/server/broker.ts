// The L0 broker. Everything in this file is REAL: HMAC-signed rotating nonces, session
// issuance/expiry, per-session rate limiting, and a single-active-dispatch gate. All
// verification is timed with performance.now() and surfaced to the UI in microseconds.
// The HMAC key lives in memory for the demo; production note: KMS-backed, rotated.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  DESTINATIONS,
  type BrokerEvent,
  type CheckinFail,
  type CheckinOk,
  type DispatchFail,
  type DispatchOk,
  type EventKind,
  type KioskNonceResponse,
  type MetricsResponse,
} from "../lib/types";

const ROTATE_MS = 60_000; // kiosk QR rotation window
const GRACE_MS = 15_000; // scan-at-the-boundary grace
const SESSION_TTL_MS = 15 * 60_000;
const RATE_LIMIT_N = 3; // dispatches per window per session
const RATE_WINDOW_MS = 60_000;

const KEY = randomBytes(32);

// --- compact signed tokens: base64url(json) + "." + truncated HMAC-SHA256 -----------

function sign(payload: string): string {
  return createHmac("sha256", KEY).update(payload).digest("base64url").slice(0, 22); // 128 bits
}

function encode(obj: object): string {
  const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${p}.${sign(p)}`;
}

function decode<T>(code: unknown): T | null {
  if (typeof code !== "string") return null;
  const dot = code.lastIndexOf(".");
  if (dot <= 0) return null;
  const p = code.slice(0, dot);
  const got = Buffer.from(code.slice(dot + 1));
  const want = Buffer.from(sign(p));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(Buffer.from(p, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

interface NoncePayload {
  k: "nonce";
  iat: number;
}
interface SessionPayload {
  k: "session";
  sid: string;
  iat: number;
  exp: number;
}

// --- state --------------------------------------------------------------------------

interface SessionRecord {
  exp: number;
  recent: number[]; // dispatch timestamps inside the rate window
  activeUntil: number; // single-active-dispatch gate
}
const sessions = new Map<string, SessionRecord>();

const counters = { filtered: 0, sessionsIssued: 0, rateLimited: 0, dispatchesOk: 0 };
const events: BrokerEvent[] = [];

function logEvent(source: string, endpoint: string, verdict: string, micros: number, kind: EventKind) {
  events.push({ t: Date.now(), source, endpoint, verdict, micros, kind });
  if (events.length > 200) events.splice(0, events.length - 200);
}

function kindFor(status: number, source: string): EventKind {
  if (status >= 400) return "blocked";
  return source.startsWith("attacker") ? "warn" : "ok";
}

// --- kiosk nonce (epoch-aligned so every poll inside a window sees the same code) ----

export function kioskNonce(): KioskNonceResponse {
  const now = Date.now();
  const iat = Math.floor(now / ROTATE_MS) * ROTATE_MS;
  return {
    code: encode({ k: "nonce", iat } satisfies NoncePayload),
    issuedAt: iat,
    rotateInSeconds: Math.ceil((iat + ROTATE_MS - now) / 1000),
    serverNow: now,
  };
}

// DEMO-ONLY fallback helper (labeled in the UI): a code minted 2 minutes in the past,
// so the stale-rejection scene never depends on stage timing. The verification path it
// exercises is the real one.
export function expiredNonce(): { code: string } {
  return { code: encode({ k: "nonce", iat: Date.now() - 2 * ROTATE_MS } satisfies NoncePayload) };
}

// --- check-in: rotating code -> anonymous 15-minute session --------------------------

export function checkin(
  body: unknown,
  source: string
): { status: number; data: CheckinOk | CheckinFail } {
  const t0 = performance.now();
  const code = (body as { code?: unknown })?.code;
  const nonce = decode<NoncePayload>(code);
  const now = Date.now();

  const fail = (error: CheckinFail["error"]) => {
    const verifyMicros = micros(t0);
    counters.filtered += 1;
    logEvent(source, "/api/checkin", `401 ${error}`, verifyMicros, "blocked");
    return { status: 401, data: { error, verifyMicros } };
  };

  if (!nonce || nonce.k !== "nonce") return fail("BAD_CODE");
  if (now - nonce.iat > ROTATE_MS + GRACE_MS) return fail("STALE_CODE");

  const sid = randomUUID().slice(0, 8);
  const exp = now + SESSION_TTL_MS;
  const token = encode({ k: "session", sid, iat: now, exp } satisfies SessionPayload);
  sessions.set(sid, { exp, recent: [], activeUntil: 0 });
  counters.sessionsIssued += 1;
  const verifyMicros = micros(t0);
  logEvent(source, "/api/checkin", "200 SESSION_ISSUED", verifyMicros, kindFor(200, source));
  return { status: 200, data: { token, sessionId: sid, expiresAt: exp, verifyMicros } };
}

// --- dispatch gate: session + rate limit + single active dispatch --------------------

export function dispatch(
  authorization: string | undefined,
  body: unknown,
  source: string
): { status: number; data: DispatchOk | DispatchFail } {
  const t0 = performance.now();
  const now = Date.now();

  const fail = (status: number, error: DispatchFail["error"], retryInSeconds?: number) => {
    const verifyMicros = micros(t0);
    if (status === 401) counters.filtered += 1;
    if (status === 429) counters.rateLimited += 1;
    logEvent(source, "/api/dispatch", `${status} ${error}`, verifyMicros, "blocked");
    return { status, data: { error, retryInSeconds, verifyMicros } };
  };

  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const session = decode<SessionPayload>(token);
  if (!session || session.k !== "session") return fail(401, "NO_SESSION");
  if (now > session.exp) return fail(401, "SESSION_EXPIRED");

  // Signature is valid, so the record can be rebuilt if the broker restarted mid-session.
  let record = sessions.get(session.sid);
  if (!record) {
    record = { exp: session.exp, recent: [], activeUntil: 0 };
    sessions.set(session.sid, record);
  }

  const destinationId = (body as { destinationId?: unknown })?.destinationId;
  const dest = DESTINATIONS.find((d) => d.id === destinationId);
  if (!dest) return fail(400, "BAD_DESTINATION");

  // Rate limit counts ATTEMPTS (standard practice), so hammering the button while a
  // dispatch is running still burns budget and lands on RATE_LIMITED, not just
  // DISPATCH_IN_PROGRESS. A rate-limited attempt itself doesn't extend the window.
  record.recent = record.recent.filter((t) => now - t < RATE_WINDOW_MS);
  if (record.recent.length >= RATE_LIMIT_N) {
    const retry = Math.ceil((record.recent[0] + RATE_WINDOW_MS - now) / 1000);
    return fail(429, "RATE_LIMITED", retry);
  }
  record.recent.push(now);
  if (record.activeUntil > now) {
    return fail(429, "DISPATCH_IN_PROGRESS", Math.ceil((record.activeUntil - now) / 1000));
  }

  record.activeUntil = now + dest.etaSeconds * 1000;
  counters.dispatchesOk += 1;
  const verifyMicros = micros(t0);
  logEvent(source, "/api/dispatch", "200 OK", verifyMicros, kindFor(200, source));
  return {
    status: 200,
    data: {
      dispatchId: randomUUID().slice(0, 8),
      destinationId: dest.id,
      etaSeconds: dest.etaSeconds,
      verifyMicros,
    },
  };
}

export function metrics(): MetricsResponse {
  return { serverNow: Date.now(), counters: { ...counters }, events: events.slice(-40) };
}

function micros(t0: number): number {
  return Math.max(1, Math.round((performance.now() - t0) * 1000));
}
