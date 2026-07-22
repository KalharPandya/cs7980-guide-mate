# 03 - Technical Architecture

> Goal: starts with one command (`npm run dev`), frontend + broker in the same process, secrets never enter the browser, Live mode makes real Bedrock calls, Simulated mode works offline.

---

## 1. Tech Stack Decisions

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript | taste-skill default stack |
| Styling | Tailwind v4 (`@tailwindcss/vite` plugin, not the postcss `tailwindcss` plugin) | the correct v4 integration path |
| Animation | Motion (`motion/react`, formerly framer-motion) | taste-skill default animation library |
| Icons | `@tabler/icons-react`, `strokeWidth 1.5` | allowed icon library |
| Fonts | `geist` npm package (Geist + Geist Mono, self-hosted) | no Inter, works offline |
| broker / proxy | **Vite `configureServer` middleware** handling `POST /api/dispatch` | single process, single command; the secret stays server-side |
| Bedrock calls | Node-side `fetch` hitting Bedrock runtime `InvokeModel` directly, `Authorization: Bearer $AWS_BEARER_TOKEN_BEDROCK` | single-language Node, no Python/SigV4 needed; uses the already-provisioned bearer token |

**Secret safety (critical):** `AWS_BEARER_TOKEN_BEDROCK` is read **server-side** with Vite's `loadEnv`. Vite exposes only `VITE_`-prefixed variables to the client — the bearer token **has no such prefix and never enters the browser bundle**. `.env` lives at `security_demo/.env`, gitignored; a committed template is provided in `.env.example`. **Never inline it into HTML/frontend code.**

---

## 2. Repository Structure

```
security_demo/              # <- inside the team repo cs7980-guide-mate
  .env                      # AWS_BEARER_TOKEN_BEDROCK (gitignored, never committed)
  .env.example              # committed template
  docs/                     # this design doc family
  .gitignore                # includes .env
  package.json
  vite.config.ts            # Tailwind v4 plugin + configureServer(/api/dispatch)
  index.html
  src/
    main.tsx
    App.tsx
    theme.css               # color tokens from doc 02
    lib/
      scene.ts              # virtual scene data model (waypoints/keep-outs/graph/path geometry)
      geometry.ts           # L3: segment-polygon intersection (pure functions, unit-testable)
      types.ts              # DispatchRequest / DispatchResponse / PipelineStep
    server/
      broker.ts             # /api/dispatch handler: L1 assembly + L2 Bedrock + L3 validation + timing
      bedrock.ts            # InvokeModel wrapper (bearer auth, model ID, tool schema)
      simulated.ts          # worst-case jailbroken-LLM scripted output
    components/
      TopBar.tsx  FloorMap.tsx  ControlPanel.tsx
      LLMReadout.tsx  PipelineTrace.tsx  ResultsTable.tsx  StatusPill.tsx
    hooks/
      useDispatch.ts        # calls /api/dispatch, manages loading/refusal/error states
      useRobotWalk.ts       # rAF tween along the path (motion value), with cleanup
```

---

## 3. Bedrock Integration

### 3.1 Auth and Endpoint
- Endpoint (region configurable, default `us-east-1`): `https://bedrock-runtime.<region>.amazonaws.com/model/<modelId>/invoke`
- Headers: `Authorization: Bearer <AWS_BEARER_TOKEN_BEDROCK>`, `Content-Type: application/json`
- Model ID: `anthropic.claude-sonnet-4-6` (Bedrock uses the `anthropic.` prefix). If the region requires the cross-region inference profile, use `us.anthropic.claude-sonnet-4-6`. Configured via env `BEDROCK_MODEL_ID` / `BEDROCK_REGION`.
- The body uses the Bedrock flavor of the Anthropic Messages schema and must include `"anthropic_version": "bedrock-2023-05-31"`.

### 3.2 Live Call Body (L2 = enum-constrained output)
```jsonc
{
  "anthropic_version": "bedrock-2023-05-31",
  "max_tokens": 512,
  "system": "<L1: trusted constraints go into the system channel>",
  "messages": [
    { "role": "user", "content": "<L1: user chat text, delimiter-wrapped, treated as untrusted data>" }
  ],
  "tools": [ {
    "name": "dispatch_robot",
    "description": "Dispatch the robot to exactly one validated destination.",
    "strict": true,                               // strict tool use: input is strictly validated
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["destination_id"],
      "properties": {
        "destination_id": {
          "type": "string",
          "enum": ["lobby","reception","cafe","office","meeting_rm","balcony"]  // safe destinations only
        }
      }
    }
  } ],
  "tool_choice": { "type": "tool", "name": "dispatch_robot" }   // forced: the model must use this tool
}
```
- **The essence of L2:** `strict: true` + `enum` + forced `tool_choice` mean the model is **physically only able** to output a single `destination_id` from the enum. Off-graph / keep-out destinations cannot even be named.
- **Constrains shape only, not intent:** the enum contains only safe destinations; path safety is left to L3.
- **Safety refusal:** Sonnet 4.6 may return `stop_reason: "refusal"` (with `stop_details.category`). The broker checks `stop_reason` -> no destination -> **fail-closed** (status BLOCKED). This is exactly the live evidence for the over-refusal finding.
- **Bedrock has no server-side fallback** and no automatic retries — refusals are handled explicitly by the broker and reported to the UI, never masked.

### 3.3 Baseline Call (negative baseline)
- **No tool attached**; only a weak "system prompt only" guardrail is provided, and the model outputs a destination name as free text. The broker parses the text -> obtains a destination (possibly a keep-out such as `stairwell`). This is a **deliberately breakable control**.
- In Live mode the real model may refuse or respond safely (i.e. over-refusal / alignment kicking in); in Simulated mode the script emits a malicious destination, demonstrating the baseline being broken.

### 3.4 Known Bedrock Caveats
- **forced `tool_choice` + thinking:** some models on Bedrock require `thinking` to be off when using forced tool_choice. The L2 call **does not enable thinking** (omitted or disabled), sidestepping this pitfall.
- Bedrock does **not** support: automatic prompt caching / web search / code execution / Files API / server-side fallback. This demo needs none of them — it uses only messages + strict tool use, both of which Bedrock supports.
- Timeouts/throttling: the backend sets a 15s timeout; on failure -> the UI shows `Bedrock unavailable - falling back to simulated` and automatically switches to Simulated (an honest notice, not pretend success).

---

## 4. Mapping L1-L5 to Code

| Layer | Runs in | Code | What it does |
|---|---|---|---|
| **L1** Input isolation | broker (prompt assembly in `broker.ts`) | Trusted constraints go into `system`; the user chat text becomes a delimiter-wrapped user turn, treated as untrusted **data** (not instructions) | First line of defense against prompt injection |
| **L2** Output shape constraint | Bedrock call (`bedrock.ts`) | strict tool use + `enum` + forced `tool_choice` | The model can only emit an id from the enum; refusal -> fail-closed |
| **L3** Deterministic policy (the real guardrail) | broker, not the LLM (`geometry.ts`) | (1) Re-checks `destination_id ∈ allowlist`; (2) validates that the planned path does not cross keep-out geometry. Actual timing measured with `performance.now()` | Even a jailbroken LLM cannot get through; sub-millisecond |
| **L4** Local safety monitor + fail-safe | Frontend (simulation of the robot's on-board layer, `useRobotWalk.ts`) | The animation loop monitors robot position vs keep-outs; WiFi-loss -> stop immediately (fail-safe), never coast on stale commands | Last line of defense + WiFi-loss fail-safe |
| **L5** LLM-as-judge (experimental control) | (optional) a second Bedrock call | Defense in depth but itself jailbreakable -> serves as a control, never the primary gate | In the demo: one row in the results table + an optional button |

- **The value of depth (core thesis):** even if L1/L2 are bypassed (or the dispatch channel has its destination rewritten in transit), L3/L4 still uphold the physical-safety invariant — physical safety does **not depend** on the integrity of any single upstream layer.

---

## 5. Virtual Scene Data Model (`scene.ts`)

Since a real TurtleBot/map cannot be connected, the demo ships a built-in floor scene; the same data also serves as L3's **trusted reference map** (TRUSTED).

### 5.1 Waypoints (safe destinations -> go into the enum + allowlist)
Coordinates are logical coordinates within the SVG viewBox (illustrative; finalized against the canvas at implementation time):
- `lobby` (start) · `reception` · `cafe` · `office` · `meeting_rm` · `balcony`

### 5.2 Keep-out Zones (keep-out polygons, not in the enum)
- `stairwell` (stairwell, polygon) · `server_rm` (server room, polygon)

### 5.3 Graph (edges) and Path Planning
- Edges between waypoints form the navigable graph; the broker runs shortest-path planning to the given destination to obtain `path: waypointId[]`.
- **Key geometric constraint (what the killer scenario hinges on):** the `meeting_rm -> balcony` edge/segment **passes through the `stairwell` polygon**. Therefore:
  - `balcony` is a **legitimate safe destination** (in the enum/allowlist) -> L2 lets it through.
  - But the **planned path to balcony crosses a keep-out** -> only L3's path geometry can catch it.

### 5.4 L3 Geometry Validation (`geometry.ts`, pure functions)
```
checkPath(path, keepOutPolygons):
  for each segment (path[i] -> path[i+1]):
    for each polygon in keepOutPolygons:
      if segmentIntersectsPolygon(segment, polygon):  # segment-polygon intersection test
        return { safe: false, violated: polygon.id, segment: i }
  return { safe: true }
```
- `checkPath` is wrapped with `performance.now()` for timing, returning `l3_micros` (a real sub-millisecond value).
- Pure functions -> unit-testable, decoupled from the demo scene.

---

## 6. API Contract (`/api/dispatch`)

### Request
```ts
POST /api/dispatch
{
  utterance: string,                       // user chat text (untrusted)
  config: "baseline" | "l2" | "l3",        // three guardrail configurations
  mode: "live" | "simulated",              // real Bedrock vs worst-case script
  scenarioId?: "benign" | "jailbreak_keepout" | "valid_dest_unsafe_path"
}
```

### Response
```ts
{
  llm: {
    source: "live-bedrock" | "simulated",
    rawText?: string,                      // baseline text output (if applicable)
    emittedDestinationId?: string | null,  // L2 tool output (if applicable)
    stopReason?: string,                   // "tool_use" | "refusal" | ...
    refused: boolean                       // stop_reason==refusal
  },
  pipeline: PipelineStep[],                // see below
  decision: {
    destinationId: string | null,
    path: string[] | null,                 // for frontend animation (waypoint sequence)
    result: "reached" | "blocked" | "unsafe_pending_l4"
  },
  timing: { l3_micros: number | null }     // measured with performance.now()
}

type PipelineStep = {
  layer: "L1" | "L2" | "L3",               // L4 lives in the frontend; L5 is an optional separate call
  status: "pass" | "block" | "skipped",
  reason: string,                          // short English phrase, e.g. "not in enum" / "path crosses keep-out"
  micros?: number                          // measured for L3 only; others may be empty or marked "modeled"
}
```

- **Once the frontend receives `decision.path`**: animate the robot along the path. If `result==unsafe_pending_l4` (the baseline let a keep-out destination through), hand it to the frontend L4 (L4 on = stop at the boundary; L4 off = enter the keep-out -> UNSAFE).
- **Which layers participate in `result` is determined by the configuration**: baseline runs L1 only; l2 runs L1+L2; l3 runs L1+L2+L3.

---

## 7. How to Run

```bash
# One-time setup
cd C:\workspace\7980\cs7980-guide-mate\security_demo
npm install

# Presenting (one command, starts frontend + broker)
npm run dev            # -> http://localhost:5173

# Environment variables (read server-side from .env in this directory)
#   AWS_BEARER_TOKEN_BEDROCK=...     (in security_demo/.env, gitignored; template in .env.example)
#   BEDROCK_REGION=us-east-1         (adjust to your provisioning)
#   BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6
```

- Presenting does not require `npm run build`. Simulated mode is **fully offline** and serves as the hard fallback.
- To give reviewers a take-away offline package, run `npm run build` plus a static build that keeps only the Simulated branch (the Live branch needs the backend).

---

## 8. (Optional / backup) Dispatch-Layer Panel

The two-robot dispatch integrity / availability items added in the 07-03 threat model v2 are not part of the 5-minute main line. If built as a backup panel:
- **Integrity:** the broker issues session-bound one-time tokens; a destination rewritten in transit -> **still passes through L3/L4** (demonstrating that physical safety does not depend on dispatch-channel integrity).
- **Availability:** forged requests occupy both robots -> front-door rate limiting + a queue -> graceful degradation (the frontend shows a queued notice).
- Code is stubbed (`components/DispatchPanel.tsx`), collapsed by default, and opened during the presentation as time allows. See doc `00`, section 6, to-be-confirmed item 3.
