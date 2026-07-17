import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  IconCamera,
  IconCheck,
  IconClockHour3,
  IconRobot,
  IconScan,
  IconX,
} from "@tabler/icons-react";
import { Panel } from "./Panel";
import { api } from "../lib/api";
import { mmss, useNow } from "../hooks/useNow";
import {
  DESTINATIONS,
  type CheckinFail,
  type CheckinOk,
  type DispatchFail,
  type DispatchOk,
  type KioskNonceResponse,
} from "../lib/types";

const SOURCE = "visitor-phone";
const STALE_AFTER_MS = 75_000; // rotation window + grace; mirrored from the broker

interface Session {
  token: string;
  sid: string;
  expiresAt: number;
}
interface Photo {
  code: string;
  takenAt: number;
}
type Dispatch =
  | { kind: "idle" }
  | { kind: "running"; destLabel: string; arriveAt: number }
  | { kind: "arrived"; destLabel: string };

// The visitor's phone, rendered as a pane. Simulated device, real requests: "scanning"
// reads the code currently on the kiosk screen (same data a camera would decode) and
// every button fires a real HTTP call against the real broker.
export function PhonePane({ className = "" }: { className?: string }) {
  const now = useNow();
  const [session, setSession] = useState<Session | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [dispatchState, setDispatchState] = useState<Dispatch>({ kind: "idle" });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  if (dispatchState.kind === "running" && now >= dispatchState.arriveAt) {
    setDispatchState({ kind: "arrived", destLabel: dispatchState.destLabel });
  }

  const checkinWith = async (code: string) => {
    const r = await api<CheckinOk | CheckinFail>("/api/checkin", {
      method: "POST",
      body: { code },
      source: SOURCE,
    });
    if (r.status === 200) {
      const ok = r.data as CheckinOk;
      setSession({ token: ok.token, sid: ok.sessionId, expiresAt: ok.expiresAt });
      setDispatchState({ kind: "idle" });
      setNotice({ text: `Checked in — verified in ${ok.verifyMicros} µs`, ok: true });
    } else {
      setNotice({ text: "Check-in failed: code expired. Scan the live screen.", ok: false });
    }
  };

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const scan = run(async () => {
    const n = await api<KioskNonceResponse>("/api/kiosk/nonce", { source: SOURCE });
    await checkinWith(n.data.code);
  });

  const photograph = run(async () => {
    const n = await api<KioskNonceResponse>("/api/kiosk/nonce", { source: SOURCE });
    setPhoto({ code: n.data.code, takenAt: Date.now() });
    setNotice(null);
  });

  const replayPhoto = run(async () => {
    if (photo) await checkinWith(photo.code);
  });

  const demoExpired = run(async () => {
    const n = await api<{ code: string }>("/api/demo/expired-nonce", { source: SOURCE });
    await checkinWith(n.data.code);
  });

  const dispatchTo = (destId: string, destLabel: string) =>
    run(async () => {
      if (!session) return;
      const r = await api<DispatchOk | DispatchFail>("/api/dispatch", {
        method: "POST",
        body: { destinationId: destId },
        token: session.token,
        source: SOURCE,
      });
      if (r.status === 200) {
        const ok = r.data as DispatchOk;
        setDispatchState({ kind: "running", destLabel, arriveAt: Date.now() + ok.etaSeconds * 1000 });
        setNotice(null);
      } else {
        const err = (r.data as DispatchFail).error;
        if (err === "RATE_LIMITED") setNotice({ text: "Too many requests — try again in a moment.", ok: false });
        else if (err === "DISPATCH_IN_PROGRESS")
          setNotice({ text: "A dispatch is already running for this session.", ok: false });
        else {
          setSession(null);
          setNotice({ text: "Session expired. Please scan again.", ok: false });
        }
      }
    });

  const photoAge = photo ? now - photo.takenAt : 0;
  const sessionLeft = session ? session.expiresAt - now : 0;

  return (
    <Panel label="Visitor phone (simulated)" className={className}>
      <div className="flex h-full items-center justify-center">
        <div className="flex w-full max-w-[290px] flex-col gap-2.5 rounded-3xl border border-line bg-bg p-3.5">
        {/* session strip */}
        {session ? (
          <div
            className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px]"
            style={{
              color: sessionLeft > 0 ? "var(--color-safe)" : "var(--color-mute)",
              borderColor: sessionLeft > 0 ? "var(--color-safe)" : "var(--color-line)",
            }}
            role="status"
          >
            <IconCheck size={14} strokeWidth={2} aria-hidden />
            <span>
              Session {session.sid} · expires in {mmss(sessionLeft)}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 font-mono text-[11px] text-mute">
            <IconX size={14} strokeWidth={2} aria-hidden />
            <span>No session — scan the kiosk to check in</span>
          </div>
        )}

        <button
          onClick={scan}
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-bg transition hover:bg-accent-hi disabled:opacity-50"
        >
          <IconScan size={18} strokeWidth={2} aria-hidden />
          Scan kiosk QR
        </button>

        {/* camera roll */}
        <div className="rounded-lg border border-dashed border-line p-2.5">
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-mute">
            <IconCamera size={13} strokeWidth={1.8} aria-hidden />
            {photo ? (
              <span>
                Camera roll — photo age{" "}
                <span style={{ color: photoAge > STALE_AFTER_MS ? "var(--color-danger)" : "var(--color-fg)" }}>
                  {mmss(photoAge)}
                </span>
                {photoAge > STALE_AFTER_MS && " (expired)"}
              </span>
            ) : (
              <span>Camera roll — empty</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <button onClick={photograph} disabled={busy} className="btn-ghost">
              Photograph QR
            </button>
            <button onClick={replayPhoto} disabled={busy || !photo} className="btn-ghost">
              Use photographed QR
            </button>
            <button onClick={demoExpired} disabled={busy} className="btn-ghost text-mute">
              Expired code (demo helper)
            </button>
          </div>
        </div>

        {/* destinations */}
        <div>
          <div className="mb-1.5 text-sm text-dim">Where to?</div>
          <div className="grid grid-cols-2 gap-1.5">
            {DESTINATIONS.map((d) => (
              <button
                key={d.id}
                onClick={dispatchTo(d.id, d.label)}
                disabled={busy || !session}
                className="rounded-lg border border-line bg-elevated px-2 py-2 text-sm transition hover:border-accent disabled:opacity-40"
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {/* status card / notices — reserved slot right under the destinations */}
        <div className="min-h-[52px]" aria-live="polite">
          <AnimatePresence mode="wait">
            {dispatchState.kind === "running" && (
              <motion.div
                key="running"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-lg border border-accent px-3 py-2.5 text-sm"
                style={{ color: "var(--color-accent-hi)" }}
              >
                <IconRobot size={18} strokeWidth={1.8} aria-hidden />
                <span>
                  Robot dispatched — arriving in{" "}
                  <span className="font-mono">{Math.max(0, Math.ceil((dispatchState.arriveAt - now) / 1000))}s</span>
                </span>
              </motion.div>
            )}
            {dispatchState.kind === "arrived" && (
              <motion.div
                key="arrived"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm"
                style={{ color: "var(--color-safe)", borderColor: "var(--color-safe)" }}
              >
                <IconRobot size={18} strokeWidth={1.8} aria-hidden />
                <span>Arrived. Follow me!</span>
              </motion.div>
            )}
            {dispatchState.kind === "idle" && notice && (
              <motion.div
                key={notice.text}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs"
                style={{
                  color: notice.ok ? "var(--color-safe)" : "var(--color-danger)",
                  borderColor: notice.ok ? "var(--color-safe)" : "var(--color-danger)",
                }}
              >
                <IconClockHour3 size={15} strokeWidth={1.8} aria-hidden className="mt-0.5 shrink-0" />
                <span>{notice.text}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        </div>
      </div>
    </Panel>
  );
}
