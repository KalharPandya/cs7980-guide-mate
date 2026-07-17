import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, normalize, join } from "node:path";
import { runDispatch } from "./broker";
import type { DispatchRequest } from "../lib/types";

// Production server for the EC2 deploy: serves the built frontend (dist/) and hosts the
// /api/dispatch broker in one process. Bedrock auth uses the instance role via SigV4
// (see bedrock.ts); no secret is stored on the box. See docs/03-architecture.md.

const PORT = Number(process.env.PORT || 8080);
const DIST = resolve(process.env.DIST_DIR || "dist");
const env = process.env as Record<string, string>;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((res, rej) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        res(JSON.parse(raw || "{}"));
      } catch (e) {
        rej(e);
      }
    });
    req.on("error", rej);
  });
}

async function serveStatic(urlPath: string, res: import("node:http").ServerResponse) {
  // Prevent path traversal, then serve the file (SPA fallback to index.html).
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(DIST, safe === "/" || safe === "" ? "index.html" : safe);
  if (!filePath.startsWith(DIST)) filePath = join(DIST, "index.html");
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(DIST, "index.html"); // SPA fallback
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url === "/api/dispatch") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    try {
      const body = (await readJsonBody(req)) as DispatchRequest;
      const result = await runDispatch(body, env);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  await serveStatic(url, res);
});

server.listen(PORT, () => {
  console.log(`guardrail-demo prod server on :${PORT}, serving ${DIST}`);
});
