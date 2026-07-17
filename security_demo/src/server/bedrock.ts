import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DESTINATION_ENUM } from "../lib/scene";

// L2 lives here: enum tool + forced tool_choice on the real Claude Sonnet 4.6 on Bedrock.
// See docs/03-architecture.md section 3. The broker still re-validates the emitted id against
// the enum, so even if the model returns something off-enum the guardrail holds.
//
// Two auth paths:
//   - SigV4 (AWS SDK): used when deployed on AWS with an instance role, or when
//     BEDROCK_AUTH=sigv4. Durable, no token expiry. This is the hosted default.
//   - Bearer token: used locally when AWS_BEARER_TOKEN_BEDROCK is set. Short-lived.
// Selection: SigV4 unless a bearer token is present and BEDROCK_AUTH is not "sigv4".

export interface BedrockResult {
  rawText?: string;
  emittedDestinationId?: string | null;
  stopReason?: string;
  refused: boolean;
  error?: string;
  resolvedModelId?: string;
  authUsed?: "sigv4" | "bearer";
}

const TOOL = {
  name: "dispatch_robot",
  description: "Dispatch the robot to exactly one validated destination.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["destination_id"],
    properties: {
      destination_id: { type: "string", enum: DESTINATION_ENUM },
    },
  },
};

function geoPrefix(region: string): string {
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return "us";
}

// Most current Claude models on Bedrock are only invokable on-demand via a cross-region
// inference profile (e.g. "us.anthropic.claude-sonnet-4-6"), not the bare "anthropic.*" id.
function candidateModelIds(modelId: string, region: string): string[] {
  if (/^(us|eu|apac|us-gov)\./.test(modelId)) return [modelId];
  return [modelId, `${geoPrefix(region)}.${modelId}`];
}

const NEEDS_PROFILE = /inference profile|on-demand throughput|provisioned throughput/i;

function buildBody(opts: { system: string; user: string; useTool: boolean }) {
  const body: Record<string, unknown> = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 512,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  };
  if (opts.useTool) {
    body.tools = [TOOL];
    body.tool_choice = { type: "tool", name: TOOL.name };
  }
  return body;
}

function parseData(data: any, useTool: boolean, id: string): BedrockResult {
  const stopReason: string | undefined = data.stop_reason;
  if (stopReason === "refusal") return { refused: true, stopReason, resolvedModelId: id };
  const content: any[] = Array.isArray(data.content) ? data.content : [];
  if (useTool) {
    const toolUse = content.find((b) => b.type === "tool_use");
    return {
      refused: false,
      stopReason,
      emittedDestinationId: toolUse?.input?.destination_id ?? null,
      resolvedModelId: id,
    };
  }
  const textBlock = content.find((b) => b.type === "text");
  return { refused: false, stopReason, rawText: textBlock?.text ?? "", resolvedModelId: id };
}

async function callViaSigV4(
  opts: { system: string; user: string; useTool: boolean },
  region: string,
  modelId: string
): Promise<BedrockResult> {
  const client = new BedrockRuntimeClient({ region, requestHandler: { requestTimeout: 20000 } });
  const payload = new TextEncoder().encode(JSON.stringify(buildBody(opts)));
  const candidates = candidateModelIds(modelId, region);
  let lastError = "";
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    try {
      const resp = await client.send(
        new InvokeModelCommand({
          modelId: id,
          contentType: "application/json",
          accept: "application/json",
          body: payload,
        })
      );
      const data = JSON.parse(new TextDecoder().decode(resp.body));
      return { ...parseData(data, opts.useTool, id), authUsed: "sigv4" };
    } catch (e: any) {
      lastError = `${e?.name || "Error"} (${id}): ${String(e?.message || e).slice(0, 200)}`;
      if (NEEDS_PROFILE.test(String(e?.message || "")) && i < candidates.length - 1) continue;
      return { refused: false, error: lastError, authUsed: "sigv4" };
    }
  }
  return { refused: false, error: lastError || "Bedrock SigV4 call failed", authUsed: "sigv4" };
}

async function callViaBearer(
  opts: { system: string; user: string; useTool: boolean },
  region: string,
  modelId: string,
  token: string
): Promise<BedrockResult> {
  const payload = JSON.stringify(buildBody(opts));
  const candidates = candidateModelIds(modelId, region);
  let lastError = "";
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(id)}/invoke`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        lastError = `Bedrock ${r.status} (${id}): ${txt.slice(0, 240)}`;
        if (r.status === 400 && NEEDS_PROFILE.test(txt) && i < candidates.length - 1) continue;
        return { refused: false, error: lastError, authUsed: "bearer" };
      }
      const data: any = await r.json();
      return { ...parseData(data, opts.useTool, id), authUsed: "bearer" };
    } catch (e: any) {
      clearTimeout(timer);
      return {
        refused: false,
        error: e?.name === "AbortError" ? "Bedrock timeout" : String(e),
        authUsed: "bearer",
      };
    }
  }
  return { refused: false, error: lastError || "Bedrock call failed", authUsed: "bearer" };
}

export async function callBedrock(
  opts: { system: string; user: string; useTool: boolean },
  env: Record<string, string>
): Promise<BedrockResult> {
  const region = env.BEDROCK_REGION || env.AWS_REGION || "us-west-2";
  const modelId = env.BEDROCK_MODEL_ID || "anthropic.claude-sonnet-4-6";
  const token = env.AWS_BEARER_TOKEN_BEDROCK;
  const useSigV4 = env.BEDROCK_AUTH === "sigv4" || !token;
  return useSigV4
    ? callViaSigV4(opts, region, modelId)
    : callViaBearer(opts, region, modelId, token);
}
