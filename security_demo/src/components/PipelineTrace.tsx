import { motion, useReducedMotion } from "motion/react";
import type { PipelineStep } from "../lib/types";
import { LAYER_LABELS } from "../lib/uiConfig";
import { Panel } from "./Panel";

const STATUS_COLOR: Record<string, string> = {
  pass: "var(--color-safe)",
  block: "var(--color-danger)",
  skipped: "var(--color-mute)",
};
const STATUS_TEXT: Record<string, string> = { pass: "PASS", block: "BLOCK", skipped: "SKIPPED" };

function Row({
  index,
  label,
  status,
  reason,
  timing,
  reduce,
}: {
  index: number;
  label: string;
  status?: string;
  reason?: string;
  timing?: string;
  reduce: boolean | null;
}) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: reduce ? 0 : index * 0.09, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-start justify-between gap-4 border-b border-line py-2 last:border-0"
    >
      <div className="min-w-0">
        <div className="font-mono text-[12.5px] text-fg">{label}</div>
        {reason && <div className="mt-0.5 font-mono text-[11px] text-mute">{reason}</div>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {status && (
          <span className="font-mono text-[11px] font-semibold" style={{ color: STATUS_COLOR[status] }}>
            {STATUS_TEXT[status]}
          </span>
        )}
        {timing && <span className="font-mono text-[10.5px] text-mute">{timing}</span>}
      </div>
    </motion.div>
  );
}

export function PipelineTrace({ pipeline }: { pipeline: PipelineStep[] }) {
  const reduce = useReducedMotion();
  const byLayer = Object.fromEntries(pipeline.map((s) => [s.layer, s]));

  const l3 = byLayer["L3"];
  const l3timing =
    l3?.measured && l3.micros != null ? `measured: ${(l3.micros / 1000).toFixed(2)} ms` : undefined;

  return (
    <Panel label="Pipeline trace">
      <div className="flex flex-col">
        {(["L1", "L2", "L3"] as const).map((id, i) => {
          const step = byLayer[id];
          return (
            <Row
              key={id}
              index={i}
              label={LAYER_LABELS[id]}
              status={step?.status}
              reason={step?.reason}
              timing={id === "L3" ? l3timing : step?.status === "pass" && step.micros === 0 ? "modeled" : undefined}
              reduce={reduce}
            />
          );
        })}
        <Row index={3} label={LAYER_LABELS.L4} timing="on robot" reduce={reduce} />
        <Row index={4} label={LAYER_LABELS.L5} timing="experimental control" reduce={reduce} />
      </div>
    </Panel>
  );
}
