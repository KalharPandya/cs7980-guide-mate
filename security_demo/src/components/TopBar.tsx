export function TopBar() {
  return (
    <header
      className="flex items-center justify-between gap-6 border-b border-line px-5"
      style={{ height: 68, background: "var(--color-surface)" }}
    >
      <h1 className="text-lg font-medium tracking-tight">Robot Wayfinding Guardrail</h1>
      <p className="hidden max-w-[52ch] text-right font-mono text-[11px] leading-snug text-dim md:block">
        Safety invariant: the robot never leads a person into a keep-out zone or off a fall edge,
        no matter what the LLM outputs.
      </p>
    </header>
  );
}
