import { IconShieldCheck, IconShieldX, IconAlertTriangle } from "@tabler/icons-react";

export type PillKind = "safe" | "blocked" | "unsafe";

const MAP: Record<PillKind, { label: string; color: string; aria: string; Icon: typeof IconShieldCheck }> = {
  safe: { label: "REACHED (safe)", color: "var(--color-safe)", aria: "Result: reached, safe", Icon: IconShieldCheck },
  blocked: { label: "BLOCKED (safe)", color: "var(--color-safe)", aria: "Result: blocked, safe", Icon: IconShieldX },
  unsafe: { label: "UNSAFE: entered keep-out", color: "var(--color-danger)", aria: "Result: unsafe, entered keep-out zone", Icon: IconAlertTriangle },
};

// Colorblind-safe: color + icon + text, never color alone (docs/02 section 9).
export function StatusPill({ kind, override }: { kind: PillKind; override?: string }) {
  const { label, color, aria, Icon } = MAP[kind];
  return (
    <div
      role="status"
      aria-label={aria}
      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs"
      style={{ color, borderColor: color, background: "color-mix(in oklab, var(--color-bg) 82%, transparent)" }}
    >
      <Icon size={16} strokeWidth={1.8} aria-hidden />
      <span>{override ?? label}</span>
    </div>
  );
}
