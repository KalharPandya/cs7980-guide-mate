import { useEffect, useState } from 'react'

import type { FloorPlan } from '../scene/floorPlanTypes'

/**
 * Fetches the floor-plan JSON that Floor.tsx / Walls.tsx / RoomLabels.tsx render from.
 *
 * Task 3.1's chosen approach for getting floor-14.json to the browser: it's copied verbatim to
 * world-client/public/data/floor-14.json (see that copy step in the Task 3.1 commit) rather than
 * wired through a build step. Vite serves everything under public/ unchanged at the same path,
 * so a plain fetch('/data/floor-14.json') just works with zero config. world/data/floor-14.json
 * (loaded server-side by world/src/nav/loadFloorPlan.ts) remains the source of truth; this is a
 * demo-time duplicate that must be re-copied by hand if the source file changes.
 */
export function useFloorPlan(url = '/data/floor-14.json'): {
  floorPlan: FloorPlan | null
  error: Error | null
} {
  const [floorPlan, setFloorPlan] = useState<FloorPlan | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch(url)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`useFloorPlan: fetch ${url} failed with status ${res.status}`)
        }
        return res.json() as Promise<FloorPlan>
      })
      .then((data) => {
        if (!cancelled) setFloorPlan(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)))
      })

    return () => {
      cancelled = true
    }
  }, [url])

  return { floorPlan, error }
}
