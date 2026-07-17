import type { ReactNode } from "react";

// Double-bezel container reused from security_demo: outer shell + inner core with
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
      style={{ background: "var(--color-surface)", boxShadow: "0 8px 30px -12px #00000099" }}
    >
      <div
        className="flex h-full flex-col rounded-[var(--radius-core)] p-4"
        style={{ background: "var(--color-elevated)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)" }}
      >
        {label && (
          <div className="mb-3 shrink-0 font-mono text-[11px] uppercase tracking-wider text-mute">{label}</div>
        )}
        {/* Children get the height that remains after the label, so a child using h-full
            fills the real available space instead of the full core (which would overflow
            by the label's height and push bottom content past the border). */}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
