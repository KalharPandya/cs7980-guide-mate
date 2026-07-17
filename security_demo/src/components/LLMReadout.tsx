import type { LlmView, ModelMode } from "../lib/types";
import { Panel } from "./Panel";

export function LLMReadout({
  llm,
  loading,
  mode,
}: {
  llm: LlmView | null;
  loading: boolean;
  mode: ModelMode;
}) {
  const title =
    mode === "live"
      ? "Live LLM output (Claude Sonnet 4.6 on Bedrock)"
      : "Simulated LLM output (worst-case: jailbroken)";

  return (
    <Panel label={title}>
      {loading ? (
        <div className="flex items-center gap-3">
          <div className="h-3 w-40 animate-pulse rounded bg-line" />
          <span className="font-mono text-[11px] text-mute">Calling Claude Sonnet 4.6 on Bedrock...</span>
        </div>
      ) : llm?.refused ? (
        <p className="font-mono text-sm" style={{ color: "var(--color-danger)" }}>
          Live model refused. stop_reason: refusal
        </p>
      ) : llm ? (
        <div className="font-mono text-sm">
          <span className="text-mute">destination_id:</span>{" "}
          <span className="text-fg">
            {llm.emittedDestinationId ??
              (llm.rawText ? extractId(llm.rawText) : "none")}
          </span>
          {llm.fallbackError && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--color-danger)" }}>
              Bedrock unavailable, fell back to simulated. {llm.fallbackError}
            </p>
          )}
        </div>
      ) : (
        <p className="font-mono text-sm text-mute">destination_id: none</p>
      )}
    </Panel>
  );
}

function extractId(text: string): string {
  const m = text.match(/destination:\s*([a-z_]+)/i);
  return m ? m[1] : "none";
}
