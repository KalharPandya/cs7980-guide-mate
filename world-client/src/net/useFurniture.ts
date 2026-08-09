import { useEffect, useState } from 'react'

import { assetUrl } from '../assetUrl'
import type { FurniturePlan } from '../scene/Furniture'

/**
 * Fetches the furniture footprints that Furniture.tsx renders from.
 *
 * Deliberately a straight copy of useFloorPlan.ts's shape rather than a shared generic: the two
 * differ in exactly one thing (the URL), and the value of keeping them as separate, boringly
 * obvious hooks is that the failure modes stay separate too -- a furniture fetch that 404s must
 * leave the floor plan (walls, rooms, navmesh-relevant geometry) rendering normally, and
 * Furniture.tsx treats a null result as "draw nothing" for exactly that reason.
 *
 * world/data/floor-14-furniture.json is the source of truth; world-client/public/data/ holds the
 * copy the browser actually fetches, the same arrangement floor-14.json uses. Unlike floor-14.json
 * these two cannot drift, because nobody hand-edits them: world/data/tools/extract_furniture.py
 * writes BOTH copies on every run.
 *
 * The default path goes through assetUrl() for the same reason useFloorPlan's does: production
 * serves this client under `/viz/`, where a root-absolute literal would 404 (see assetUrl.ts).
 */
export function useFurniture(url = assetUrl('/data/floor-14-furniture.json')): {
  furniture: FurniturePlan | null
  error: Error | null
} {
  const [furniture, setFurniture] = useState<FurniturePlan | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch(url)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`useFurniture: fetch ${url} failed with status ${res.status}`)
        }
        return res.json() as Promise<FurniturePlan>
      })
      .then((data) => {
        if (!cancelled) setFurniture(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)))
      })

    return () => {
      cancelled = true
    }
  }, [url])

  return { furniture, error }
}
