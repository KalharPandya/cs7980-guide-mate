export interface Point {
  x: number;
  y: number;
}

export type GuardrailConfig = "baseline" | "l2" | "l3";
export type ModelMode = "live" | "simulated";
export type ScenarioId = "benign" | "jailbreak_keepout" | "valid_dest_unsafe_path";

export interface DispatchRequest {
  utterance: string;
  config: GuardrailConfig;
  mode: ModelMode;
  scenarioId: ScenarioId;
}

export interface LlmView {
  source: "live-bedrock" | "simulated";
  rawText?: string;
  emittedDestinationId?: string | null;
  stopReason?: string;
  refused: boolean;
  fallbackError?: string; // set when Live failed and we fell back to simulated
}

export type LayerId = "L1" | "L2" | "L3";
export type LayerStatus = "pass" | "block" | "skipped";

export interface PipelineStep {
  layer: LayerId;
  status: LayerStatus;
  reason: string;
  micros?: number; // measured for L3, undefined (or modeled) elsewhere
  measured?: boolean;
}

export type DispatchResult = "reached" | "blocked" | "unsafe";

export interface DispatchDecision {
  destinationId: string | null;
  result: DispatchResult;
  path: Point[]; // pixel points for the robot to follow; empty if blocked
  keepOutViolated?: string;
}

export interface DispatchResponse {
  llm: LlmView;
  pipeline: PipelineStep[];
  decision: DispatchDecision;
  timing: { l3_micros: number | null };
}
