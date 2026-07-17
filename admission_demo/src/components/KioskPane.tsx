import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import QRCode from "qrcode";
import { IconQrcode } from "@tabler/icons-react";
import { Panel } from "./Panel";
import { api } from "../lib/api";
import type { KioskNonceResponse } from "../lib/types";

// The front-desk kiosk screen. Polls the broker once a second; the code is epoch-aligned
// server-side, so every poll inside a 60 s window renders the same QR. The QR encodes a
// real, scannable check-in URL (only the phone is simulated, not the code).
export function KioskPane({ className = "" }: { className?: string }) {
  const [nonce, setNonce] = useState<KioskNonceResponse | null>(null);
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await api<KioskNonceResponse>("/api/kiosk/nonce", { source: "kiosk" });
        if (alive) setNonce(r.data);
      } catch {
        /* dev-server restart between polls; next tick recovers */
      }
    };
    void poll();
    const id = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!nonce) return;
    const url = `${window.location.origin}/checkin?c=${nonce.code}`;
    void QRCode.toString(url, {
      type: "svg",
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: "#0b0c0e", light: "#0000" },
    }).then(setSvg);
  }, [nonce?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const rotateIn = nonce?.rotateInSeconds ?? 60;

  return (
    <Panel label="Kiosk — front desk display" className={className}>
      <div className="flex h-full flex-col items-center gap-4 text-center">
        <div className="shrink-0">
          <div className="flex items-center justify-center gap-2 text-lg font-semibold">
            <IconQrcode size={20} strokeWidth={1.8} aria-hidden />
            GuideMate Check-in
          </div>
          <div className="mt-1 text-sm text-dim">Scan to use the guide robot</div>
        </div>

        {/* A kiosk shows dark modules on a light card — real-world contrast, scannable.
            flex-1 + min-h-0 lets this area absorb the panel's spare height and centers the
            QR, so the footer below can never be pushed past the panel border. */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={nonce?.code ?? "loading"}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              transition={{ duration: 0.25 }}
              className="rounded-[var(--radius-core)] bg-fg p-4"
              role="img"
              aria-label="Rotating check-in QR code"
            >
              <div className="h-40 w-40 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="w-full shrink-0 space-y-2">
          <div className="flex items-center justify-center gap-2 font-mono text-xs text-dim" aria-live="off">
            <CountdownRing fraction={rotateIn / 60} />
            <span>
              Code refreshes in <span className="text-fg">{rotateIn}s</span>
            </span>
          </div>
          <div className="border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-mute">
            guidemate.example.edu
            <br />
            verify before you scan
          </div>
        </div>
      </div>
    </Panel>
  );
}

function CountdownRing({ fraction }: { fraction: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--color-line)" strokeWidth="2.5" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, fraction)))}
        transform="rotate(-90 9 9)"
        style={{ transition: "stroke-dashoffset 0.9s linear" }}
      />
    </svg>
  );
}
