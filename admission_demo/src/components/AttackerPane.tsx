import { useEffect, useRef, useState } from "react";
import { IconTerminal2 } from "@tabler/icons-react";
import { Panel } from "./Panel";
import { api } from "../lib/api";
import type {
  CheckinFail,
  CheckinOk,
  DispatchFail,
  DispatchOk,
  KioskNonceResponse,
} from "../lib/types";

type Tone = "cmd" | "info" | "blocked" | "warn";
interface Line {
  id: number;
  text: string;
  tone: Tone;
}

const TONE_COLOR: Record<Tone, string> = {
  cmd: "var(--color-fg)",
  info: "var(--color-dim)",
  blocked: "var(--color-safe)", // defense held — same emerald discipline as security_demo
  warn: "var(--color-warn)", // admitted but untrusted — the honest amber
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Scripted attacker plays. The script is theater; the requests are not — every play
// fires real HTTP calls at the real broker and prints the real verdicts and timings.
export function AttackerPane({ className = "" }: { className?: string }) {
  const [lines, setLines] = useState<Line[]>([
    { id: 0, text: "attacker@remote:~$ _", tone: "info" },
  ]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  const say = async (text: string, tone: Tone, delayMs = 350) => {
    setLines((ls) => [...ls, { id: nextId.current++, text, tone }]);
    await sleep(delayMs);
  };

  const play = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const directHit = play(async () => {
    await say(`$ curl -X POST /api/dispatch -d '{"destinationId":"cafe"}'  # no session`, "cmd");
    const r = await api<DispatchOk | DispatchFail>("/api/dispatch", {
      method: "POST",
      body: { destinationId: "cafe" },
      source: "attacker",
    });
    const fail = r.data as DispatchFail;
    await say(`BLOCKED ${r.status} ${fail.error} · verified in ${fail.verifyMicros} µs`, "blocked");
  });

  const staleReplay = play(async () => {
    await say("$ replay a code photographed 2 minutes ago", "cmd");
    const n = await api<{ code: string }>("/api/demo/expired-nonce", { source: "attacker" });
    const r = await api<CheckinOk | CheckinFail>("/api/checkin", {
      method: "POST",
      body: { code: n.data.code },
      source: "attacker",
    });
    const fail = r.data as CheckinFail;
    await say(`BLOCKED ${r.status} ${fail.error} · verified in ${fail.verifyMicros} µs`, "blocked");
  });

  const tokenRelay = play(async () => {
    await say("> accomplice on site scans the live kiosk QR…", "info");
    const n = await api<KioskNonceResponse>("/api/kiosk/nonce", { source: "attacker-accomplice" });
    const c = await api<CheckinOk | CheckinFail>("/api/checkin", {
      method: "POST",
      body: { code: n.data.code },
      source: "attacker-accomplice",
    });
    if (c.status !== 200) {
      await say(`relay failed: ${(c.data as CheckinFail).error}`, "info");
      return;
    }
    const ok = c.data as CheckinOk;
    await say(`> session ${ok.sessionId} relayed to remote attacker`, "info");
    await say(`$ curl -X POST /api/dispatch -H "Authorization: Bearer …" -d '{"destinationId":"library"}'`, "cmd");
    const r = await api<DispatchOk | DispatchFail>("/api/dispatch", {
      method: "POST",
      body: { destinationId: "library" },
      token: ok.token,
      source: "attacker-remote",
    });
    if (r.status === 200) {
      await say(`200 OK — dispatch ${(r.data as DispatchOk).dispatchId} accepted`, "cmd");
      await say("PASSED L0 — presence was borrowed. This is L1–L5's job.", "warn");
    } else {
      await say(`${r.status} ${(r.data as DispatchFail).error}`, "blocked");
    }
  });

  return (
    <Panel label="Attacker terminal (scripted plays, real requests)" className={className}>
      <div className="flex h-full flex-col gap-3">
        {/* flex-1 + min-h-0 lets the log absorb spare height and shrink under pressure,
            so the shrink-0 button row below can never be pushed past the panel border. */}
        <div
          ref={scrollRef}
          className="min-h-[160px] flex-1 overflow-y-auto rounded-[var(--radius-core)] border border-line bg-bg p-3 font-mono text-xs leading-relaxed"
          role="log"
          aria-label="Attacker terminal output"
        >
          {lines.map((l) => (
            <div key={l.id} style={{ color: TONE_COLOR[l.tone] }}>
              {l.text}
            </div>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <PlayButton onClick={directHit} disabled={busy} n={1} label="Direct API hit — no session" />
          <PlayButton onClick={staleReplay} disabled={busy} n={2} label="Replay a stale code" />
          <PlayButton onClick={tokenRelay} disabled={busy} n={3} label="Token relay — on-site accomplice" />
        </div>
      </div>
    </Panel>
  );
}

function PlayButton({
  onClick,
  disabled,
  n,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  n: number;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-md border border-line bg-elevated px-2.5 py-1.5 text-xs text-dim transition hover:border-accent hover:text-fg disabled:opacity-40"
    >
      <IconTerminal2 size={14} strokeWidth={1.8} aria-hidden />
      <span className="font-mono text-mute">{n}</span>
      {label}
    </button>
  );
}
