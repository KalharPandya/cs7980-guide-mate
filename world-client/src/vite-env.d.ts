/// <reference types="vite/client" />

// Augments Vite's built-in import.meta.env typing (pulled in via tsconfig `types: ["vite/client"]`)
// with this app's own build-time vars. VITE_GOOGLE_MAPS_API_KEY is the Google Cloud Maps API key
// the Photorealistic 3D Tiles renderer authenticates with (see scene/GoogleTiles.tsx). It is
// inlined at build time by Vite; when it is an empty string the app falls back to the procedural
// Skyline (see App.tsx), so this being declared does NOT mean a key is present at runtime.
interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
