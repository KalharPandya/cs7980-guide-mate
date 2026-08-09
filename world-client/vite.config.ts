import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Minimal local declaration of the one Node global this config touches. tsconfig.json's
// `types` is ["vite/client"] and the project has no @types/node dependency; adding one just to
// read a single build-time env var would pull Node's whole global surface into type-checking
// for src/ as well. Vite runs this file in Node, so `process` genuinely exists at runtime.
declare const process: { env: Record<string, string | undefined> }

// Virtual world guide fleet -- big-screen R3F client scaffold (Task 0.2).
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Deploy base path, build-time only. Left at Vite's default '/' so `npm run dev` (5173/5175)
  // and `npm run preview` keep serving from the root exactly as before. The container image
  // sets VITE_BASE_PATH=/viz/ (see world-client/Dockerfile) because production serves this
  // client under https://{domain}/viz/ alongside the chat app at '/' -- an env var rather than
  // a hardcoded '/viz/' so the sub-path stays a deployment decision, not a source-code one.
  // This drives index.html's asset URLs AND import.meta.env.BASE_URL, which src/assetUrl.ts
  // uses for the runtime public/ fetches (floor-plan JSON, GLB models) that a bundler cannot
  // rewrite on its own.
  base: process.env.VITE_BASE_PATH ?? '/',
})
