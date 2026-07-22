import type { ReactNode } from "react";

// Double-bezel container (high-end-visual-design section 4.A): outer shell + inner core with
// concentric radii and an inset highlight. Gives panels a machined-hardware feel.
export function Panel({
  label,
  children,
  className = "",
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[var(--radius-panel)] border border-line p-1.5 ${className}`}
      style={{ background: "var(--color-surface)", boxShadow: "var(--shadow, 0 8px 30px -12px #00000099)" }}
    >
      <div
        className="rounded-[var(--radius-core)] p-4"
        style={{ background: "var(--color-elevated)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)" }}
      >
        {label && (
          <div className="mb-3 font-mono text-[11px] uppercase tracking-wider text-mute">{label}</div>
        )}
        {children}
      </div>
    </div>
  );
}
