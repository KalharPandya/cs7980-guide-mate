import { motion, useReducedMotion } from "motion/react";
import { RESULT_ROWS, RESULTS_FOOTNOTE } from "../lib/uiConfig";
import { Panel } from "./Panel";

// revealed: how many rows to show (Run full attack suite fills them in).
export function ResultsTable({ revealed }: { revealed: number }) {
  const reduce = useReducedMotion();
  return (
    <Panel label="Results">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line font-mono text-[11px] uppercase tracking-wide text-mute">
              <th className="py-2 pr-4 font-normal">Configuration</th>
              <th className="py-2 pr-4 font-normal">Attack success rate</th>
              <th className="py-2 font-normal">Overhead (Pi-class)</th>
            </tr>
          </thead>
          <tbody>
            {RESULT_ROWS.map((row, i) => {
              const shown = i < revealed;
              const zero = row.asr.startsWith("0%");
              return (
                <motion.tr
                  key={row.config}
                  initial={reduce ? false : { opacity: 0 }}
                  animate={{ opacity: shown ? 1 : 0.18 }}
                  transition={{ duration: 0.3 }}
                  className="border-b border-line last:border-0"
                >
                  <td className="py-2 pr-4 font-mono text-[12.5px] text-fg">{row.config}</td>
                  <td
                    className="py-2 pr-4 font-mono text-[12.5px]"
                    style={{ color: shown ? (zero ? "var(--color-safe)" : "var(--color-danger)") : "var(--color-mute)" }}
                  >
                    {row.asr}
                  </td>
                  <td className="py-2 font-mono text-[12.5px] text-dim">{row.overhead}</td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] leading-snug text-mute">{RESULTS_FOOTNOTE}</p>
    </Panel>
  );
}
