import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { brokerPlugin } from "./src/server/brokerPlugin";

// The demo's broker (Vite middleware) needs AWS_BEARER_TOKEN_BEDROCK, which lives in
// Demo/.env (one level up from this repo). loadEnv with envDir = ".." reads it server-side.
// Vite only exposes VITE_-prefixed vars to the client bundle, so the token never ships
// to the browser. See docs/03-architecture.md section 1.
export default defineConfig(({ mode }) => {
  const parentEnv = loadEnv(mode, resolve(__dirname, ".."), "");
  const localEnv = loadEnv(mode, __dirname, "");
  const env = { ...parentEnv, ...localEnv, ...process.env } as Record<string, string>;
  return {
    plugins: [react(), tailwindcss(), brokerPlugin(env)],
  };
});
