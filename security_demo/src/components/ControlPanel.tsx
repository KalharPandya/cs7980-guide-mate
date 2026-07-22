import { IconWifiOff, IconPlayerPlay } from "@tabler/icons-react";
import type { GuardrailConfig, ModelMode, ScenarioId } from "../lib/types";
import { CONFIGS, SCENARIOS } from "../lib/uiConfig";
import { Panel } from "./Panel";

interface Props {
  config: GuardrailConfig;
  setConfig: (c: GuardrailConfig) => void;
  mode: ModelMode;
  setMode: (m: ModelMode) => void;
  l4on: boolean;
  setL4on: (v: boolean) => void;
  activeScenario: ScenarioId | null;
  onScenario: (s: ScenarioId) => void;
  onWifiJam: () => void;
  onRunSuite: () => void;
  running: boolean;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="grid gap-1 rounded-md border border-line p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))`, background: "var(--color-bg)" }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            className="rounded-[5px] px-2 py-1.5 text-xs transition-[transform,background,color] duration-200 active:scale-[0.98]"
            style={{
              background: active ? "var(--color-accent)" : "transparent",
              color: active ? "var(--color-bg)" : "var(--color-dim)",
              fontWeight: active ? 600 : 400,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ControlPanel(props: Props) {
  const {
    config,
    setConfig,
    mode,
    setMode,
    l4on,
    setL4on,
    activeScenario,
    onScenario,
    onWifiJam,
    onRunSuite,
    running,
  } = props;

  return (
    <div className="flex flex-col gap-4">
      <Panel label="Guardrail config">
        <Segmented value={config} options={CONFIGS} onChange={setConfig} ariaLabel="Guardrail config" />
      </Panel>

      <Panel label="Scenario">
        <div className="flex flex-col gap-2">
          {SCENARIOS.map((s) => {
            const active = s.id === activeScenario;
            return (
              <button
                key={s.id}
                onClick={() => onScenario(s.id)}
                disabled={running}
                aria-pressed={active}
                className="rounded-md border px-3 py-2 text-left text-sm transition-[transform,border-color] duration-200 active:scale-[0.99] disabled:opacity-50"
                style={{
                  borderColor: active ? "var(--color-accent)" : "var(--color-line)",
                  background: active ? "color-mix(in oklab, var(--color-accent) 12%, transparent)" : "transparent",
                }}
              >
                <span className="block font-mono text-[13px] leading-snug text-fg">{s.utterance}</span>
                <span className="mt-0.5 block text-[11px] text-mute">{s.note}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel label="Model source">
        <Segmented
          value={mode}
          options={[
            { id: "live", label: "Live Bedrock" },
            { id: "simulated", label: "Simulated" },
          ]}
          onChange={setMode}
          ariaLabel="Model source"
        />
        <p className="mt-2 text-[11px] leading-snug text-mute">
          {mode === "live"
            ? "Real Claude Sonnet 4.6 on Bedrock. May refuse the jailbreak (that is our finding)."
            : "Worst-case: an already-jailbroken model. The only way to show the full attack story."}
        </p>
      </Panel>

      <div className="flex flex-col gap-2">
        <label className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm">
          <span className="text-dim">L4 local safety monitor</span>
          <button
            role="switch"
            aria-checked={l4on}
            onClick={() => setL4on(!l4on)}
            className="relative box-border inline-flex h-5 w-9 shrink-0 items-center rounded-full border-0 p-0 transition-colors duration-200"
            style={{ background: l4on ? "var(--color-safe)" : "var(--color-line)" }}
          >
            <span
              className="pointer-events-none inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200"
              style={{ transform: l4on ? "translateX(18px)" : "translateX(2px)" }}
            />
          </button>
        </label>

        <button
          onClick={onWifiJam}
          disabled={running}
          className="flex items-center justify-center gap-2 rounded-full border border-line px-4 py-2.5 text-sm text-fg transition-[transform] duration-200 active:scale-[0.98] disabled:opacity-50"
        >
          <IconWifiOff size={16} strokeWidth={1.5} aria-hidden />
          Simulate WiFi loss / jam
        </button>

        <button
          onClick={onRunSuite}
          disabled={running}
          className="flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-[transform] duration-200 active:scale-[0.98] disabled:opacity-50"
          style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
        >
          <IconPlayerPlay size={16} strokeWidth={1.8} aria-hidden />
          Run full attack suite
        </button>
      </div>
    </div>
  );
}
