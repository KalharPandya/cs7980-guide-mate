import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkin, dispatch, expiredNonce, kioskNonce, metrics } from "./broker";

// Vite dev-server middleware that IS the broker (same pattern as security_demo).
// One `npm run dev` serves the frontend and these /api/* endpoints in one process.
export function brokerPlugin(): Plugin {
  return {
    name: "admission-broker",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        const source = String(req.headers["x-demo-source"] ?? "unknown");

        if (req.method === "GET" && url === "/api/kiosk/nonce") return json(res, 200, kioskNonce());
        if (req.method === "GET" && url === "/api/metrics") return json(res, 200, metrics());
        if (req.method === "GET" && url === "/api/demo/expired-nonce") return json(res, 200, expiredNonce());

        if (req.method === "POST" && url === "/api/checkin") {
          return readBody(req, (body) => {
            const r = checkin(body, source);
            json(res, r.status, r.data);
          });
        }
        if (req.method === "POST" && url === "/api/dispatch") {
          return readBody(req, (body) => {
            const r = dispatch(req.headers.authorization, body, source);
            json(res, r.status, r.data);
          });
        }
        next();
      });
    },
  };
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, cb: (body: unknown) => void) {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    try {
      cb(raw ? JSON.parse(raw) : {});
    } catch {
      cb({});
    }
  });
}
