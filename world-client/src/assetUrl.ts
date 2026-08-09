/**
 * Resolves a path under `public/` (floor-plan JSON, GLB models) against the app's deploy-time
 * base path.
 *
 * WHY this exists: Vite rewrites the base path into `index.html` and into anything reached
 * through an `import`, but a bare string literal like `fetch('/data/floor-14.json')` or
 * `useGLTF('/models/robot.glb')` is just runtime data -- the bundler never sees it as a URL and
 * never touches it. Those root-absolute literals are correct while the app is served from `/`
 * (dev on 5173/5175, `npm run preview`), and silently 404 the moment it is served from a
 * sub-path. Production serves this client under `/viz/` behind Caddy (see agent_service/Caddyfile
 * and world-client/Dockerfile's VITE_BASE_PATH build arg), so every one of those literals has to
 * go through here.
 *
 * `import.meta.env.BASE_URL` is Vite's own canonical value for this: it is `/` for a default
 * build and `/viz/` when the build ran with `base: '/viz/'`. It always has a trailing slash.
 *
 * The defensive `(import.meta as ...)` cast + `?? '/'` matches the pattern already used in
 * net/useWorldRoom.ts, and is load-bearing rather than decorative: several modules that call this
 * (scene/Visitor.tsx for one) are imported directly by the `tsx`-run tests in
 * src/scene/__tests__/, i.e. by plain Node, where `import.meta.env` does not exist at all and a
 * direct property read would throw at module-evaluation time and take the test suite with it.
 */
const BASE_URL = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'

/**
 * @param path A root-absolute public-asset path as authored, e.g. `/models/robot.glb`.
 * @returns The same asset resolved against the deploy base, e.g. `/viz/models/robot.glb`.
 */
export function assetUrl(path: string): string {
  // BASE_URL always ends in '/', so strip the leading '/' off `path` to avoid a doubled slash.
  // A doubled slash would still resolve on most servers, but it makes the URL that shows up in
  // devtools/network logs harder to read against the Caddy route it has to match.
  return `${BASE_URL}${path.replace(/^\//, '')}`
}
