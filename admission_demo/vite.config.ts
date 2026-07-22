import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { brokerPlugin } from "./src/server/brokerPlugin";

// No env, no credentials: the L0 broker is pure deterministic logic (HMAC key is
// generated in-memory at boot). One `npm run dev` serves frontend + broker.
export default defineConfig({
  plugins: [react(), tailwindcss(), brokerPlugin()],
});
