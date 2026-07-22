import { useEffect, useState } from "react";
import { IconAlertTriangle, IconShieldCheck, IconArrowRight } from "@tabler/icons-react";
import { Panel } from "./Panel";
import { api } from "../lib/api";
import type { BrokerEvent, MetricsResponse } from "../lib/types";

// Broker-side truth: every logged request with its real verdict and measured µs cost,
// plus the counters the closing beat of the demo lands on.
export function EventLog({ className = "" }: { className?: string }) {
  const [m, setM] = useState<MetricsResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await api<MetricsResponse>("/api/metrics", { source: "console" });
        if (alive) setM(r.data);
      } catch {
        /* transient; next tick recovers */
      }
    };
    void poll();
    const id = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const events = [...(m?.events ?? [])].reverse().slice(0, 9);
  const c = m?.counters;

  return (
    <Panel label="Broker event log · metrics" className={className}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Counter label="Filtered" value={c?.filtered ?? 0} color="var(--color-safe)" />
          <Counter label="Sessions issued" value={c?.sessionsIssued ?? 0} color="var(--color-accent)" />
          <Counter label="Rate limited" value={c?.rateLimited ?? 0} color="var(--color-safe)" />
          <Counter label="Dispatches OK" value={c?.dispatchesOk ?? 0} color="var(--color-fg)" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-left uppercase tracking-wider text-mute">
                <th className="py-1 pr-4 font-normal">time</th>
                <th className="py-1 pr-4 font-normal">source</th>
                <th className="py-1 pr-4 font-normal">endpoint</th>
                <th className="py-1 pr-4 font-normal">verdict</th>
                <th className="py-1 font-normal">verify µs</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 text-mute">
                    — no requests yet —
                  </td>
                </tr>
              )}
              {events.map((e, i) => (
                <EventRow key={`${e.t}-${i}`} e={e} />
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-line pt-2 text-[11px] text-mute">
          All checks real and timed live. Phone and attacker are simulated; the broker is not.
        </div>
      </div>
    </Panel>
  );
}

function EventRow({ e }: { e: BrokerEvent }) {
  const color =
    e.kind === "blocked" ? "var(--color-safe)" : e.kind === "warn" ? "var(--color-warn)" : "var(--color-accent)";
  const Icon = e.kind === "blocked" ? IconShieldCheck : e.kind === "warn" ? IconAlertTriangle : IconArrowRight;
  return (
    <tr className="border-t border-line/60">
      <td className="py-1.5 pr-4 text-dim">{new Date(e.t).toLocaleTimeString("en-US", { hour12: false })}</td>
      <td className="py-1.5 pr-4 text-dim">{e.source}</td>
      <td className="py-1.5 pr-4 text-dim">{e.endpoint}</td>
      <td className="py-1.5 pr-4">
        <span className="inline-flex items-center gap-1.5" style={{ color }}>
          <Icon size={13} strokeWidth={1.8} aria-hidden />
          {e.verdict}
        </span>
      </td>
      <td className="py-1.5 text-fg">{e.micros}</td>
    </tr>
  );
}

function Counter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-baseline gap-2 rounded-md border border-line bg-bg px-3 py-1.5">
      <span className="font-mono text-lg tabular-nums" style={{ color }}>
        {value}
      </span>
      <span className="text-[11px] text-mute">{label}</span>
    </div>
  );
}
