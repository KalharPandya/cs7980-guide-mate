import { useRef, useState } from "react";
import type { GuardrailConfig, ModelMode, Point, ScenarioId, DispatchResponse } from "./lib/types";
import { resolvePath, isKeepOutTarget, SAFE_DESTINATIONS } from "./lib/scene";
import { SCENARIOS, RESULT_ROWS } from "./lib/uiConfig";
import { useDispatch } from "./hooks/useDispatch";
import { TopBar } from "./components/TopBar";
import { FloorMap } from "./components/FloorMap";
import { ControlPanel } from "./components/ControlPanel";
import { LLMReadout } from "./components/LLMReadout";
import { PipelineTrace } from "./components/PipelineTrace";
import { ResultsTable } from "./components/ResultsTable";
import { StatusPill, type PillKind } from "./components/StatusPill";
import { Panel } from "./components/Panel";
import type { RobotHandle } from "./components/Robot";

const REFUSAL_NOTE =
  "The real model refused an authorized, course-sanctioned test. This over-refusal is our Sprint 3-4 finding. Physical safety must not depend on the model choosing to refuse.";

function noteFor(res: DispatchResponse): string | null {
  if (res.llm.refused) return REFUSAL_NOTE;
  const block = res.pipeline.find((s) => s.status === "block");
  if (block?.layer === "L2") return "Off-map destination cannot be named. Failed closed.";
  if (block?.layer === "L3")
    return "Destination is valid but the planned path crosses a keep-out zone. Blocked by geometry.";
  if (res.decision.result === "unsafe") {
    const d = res.decision.destinationId;
    if (d && SAFE_DESTINATIONS.includes(d) && !isKeepOutTarget(d)) {
      return "L2 only constrains the destination label, not the path. The path still crosses a keep-out zone.";
    }
    return "Prompt-only defense bypassed. The robot was driven into a keep-out zone.";
  }
  return null;
}

export function App() {
  const [config, setConfig] = useState<GuardrailConfig>("baseline");
  const [mode, setMode] = useState<ModelMode>("simulated");
  const [l4on, setL4on] = useState(true);
  const [activeScenario, setActiveScenario] = useState<ScenarioId | null>(null);
  const [pill, setPill] = useState<{ kind: PillKind; override?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [noteDanger, setNoteDanger] = useState(false);
  const [pathToShow, setPathToShow] = useState<Point[]>([]);
  const [danger, setDanger] = useState(false);
  const [revealed, setRevealed] = useState(0);
  const [busy, setBusy] = useState(false);

  const robotRef = useRef<RobotHandle>(null);
  const { data, loading, error, dispatch } = useDispatch();
  const running = busy || loading;

  const resetView = () => {
    setPill(null);
    setNote(null);
    setNoteDanger(false);
    setDanger(false);
    setPathToShow([]);
    robotRef.current?.reset();
  };

  async function onScenario(sid: ScenarioId) {
    const sc = SCENARIOS.find((s) => s.id === sid)!;
    setActiveScenario(sid);
    resetView();
    setBusy(true);
    const res = await dispatch({ utterance: sc.utterance, config, mode, scenarioId: sid });
    if (!res) {
      setBusy(false);
      setNote(error);
      setNoteDanger(true);
      return;
    }
    setPathToShow(res.decision.path);
    const result = res.decision.result;
    if (result === "blocked") {
      setPill({ kind: "blocked" });
      setNote(noteFor(res));
      setBusy(false);
    } else if (result === "reached") {
      robotRef.current?.walk(res.decision.path, {}, () => {
        setPill({ kind: "safe" });
        setBusy(false);
      });
    } else {
      setDanger(true);
      robotRef.current?.walk(res.decision.path, { unsafe: true }, () => {
        setPill({ kind: "unsafe" });
        setNote(noteFor(res));
        setNoteDanger(true);
        setBusy(false);
      });
    }
  }

  function onWifiJam() {
    setActiveScenario(null);
    resetView();
    setBusy(true);
    const path = resolvePath("cafe");
    setPathToShow(path);
    robotRef.current?.walk(path, { jam: { atFraction: 0.55, l4on } }, (o) => {
      if (o === "failsafe") {
        setPill({ kind: "blocked", override: "FAIL-SAFE STOP" });
        setNote("Cloud or broker unreachable. L4 stops the robot rather than coasting on a stale command.");
      } else {
        setDanger(true);
        setPill({ kind: "unsafe", override: "UNSAFE: coasting on stale command" });
        setNote("With L4 off, the robot coasts on the last command after WiFi loss.");
        setNoteDanger(true);
      }
      setBusy(false);
    });
  }

  function onRunSuite() {
    setRevealed(0);
    let n = 0;
    const iv = setInterval(() => {
      n += 1;
      setRevealed(n);
      if (n >= RESULT_ROWS.length) clearInterval(iv);
    }, 450);
  }

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5">
        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <div className="flex flex-col gap-3">
            <Panel>
              <FloorMap
                robotRef={robotRef}
                path={pathToShow}
                danger={danger}
                statusPill={pill ? <StatusPill kind={pill.kind} override={pill.override} /> : undefined}
              />
            </Panel>
            {note && (
              <p
                className="px-1 text-[12.5px] leading-snug"
                style={{ color: noteDanger ? "var(--color-danger)" : "var(--color-dim)" }}
              >
                {note}
              </p>
            )}
          </div>

          <ControlPanel
            config={config}
            setConfig={setConfig}
            mode={mode}
            setMode={setMode}
            l4on={l4on}
            setL4on={setL4on}
            activeScenario={activeScenario}
            onScenario={onScenario}
            onWifiJam={onWifiJam}
            onRunSuite={onRunSuite}
            running={running}
          />
        </div>

        <div className="mt-4">
          <LLMReadout llm={data?.llm ?? null} loading={loading} mode={mode} />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <PipelineTrace pipeline={data?.pipeline ?? []} />
          <ResultsTable revealed={revealed} />
        </div>
      </main>
    </div>
  );
}
