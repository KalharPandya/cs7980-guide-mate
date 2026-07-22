import type { Plugin } from "vite";
import { runDispatch } from "./broker";
import type { DispatchRequest } from "../lib/types";

// Vite dev-server middleware that IS the broker. One `npm run dev` serves the frontend and
// this /api/dispatch endpoint in the same process; the Bedrock token stays server-side.
export function brokerPlugin(env: Record<string, string>): Plugin {
  return {
    name: "guardrail-broker",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/api/dispatch") {
          return next();
        }
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", async () => {
          try {
            const body = JSON.parse(raw || "{}") as DispatchRequest;
            const result = await runDispatch(body, env);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(result));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      });
    },
  };
}
