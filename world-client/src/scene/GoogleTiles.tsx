import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import {
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  ReorientationPlugin,
} from '3d-tiles-renderer/plugins'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'

/**
 * Renders the REAL downtown Vancouver around the 14th-floor plan using Google's Photorealistic
 * 3D Tiles (via the `3d-tiles-renderer` library, v0.5.x). This replaces the procedural
 * Skyline.tsx towers with actual buildings + the North Shore mountains, so the floor plan reads
 * as sitting inside the true city.
 *
 * WHY IMPERATIVE (not the r3f helper): the library ships an `3d-tiles-renderer/r3f` entrypoint,
 * but we drive a plain `TilesRenderer` by hand inside R3F because this scene needs precise control
 * over (a) where the reoriented globe sits relative to the floor and (b) mounting the city OUTSIDE
 * App.tsx's `<group scale={[1,1,-1]}>` north-up mirror -- real geography must never be z-mirrored.
 * The wiring below (useThree for camera/gl, setCamera + setResolutionFromRenderer, update() in
 * useFrame, dispose on unmount) is the documented vanilla-three integration.
 *
 * AUTH: GoogleCloudAuthPlugin handles Google Cloud Maps API session-token management. The key
 * comes from VITE_GOOGLE_MAPS_API_KEY, inlined at build time (see App.tsx: when the key is empty
 * this component is never mounted and the procedural Skyline is used instead).
 *
 * ATTRIBUTION: Google's ToS REQUIRES visible data attribution. getAttributions() is polled and
 * rendered as a small muted fixed overlay, bottom-left, via drei <Html>. Do not remove it.
 */

/** Google Cloud Maps API key, inlined by Vite at build time. Empty string -> App uses Skyline. */
const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string

/* --------------------------------------------------------------------------------------------- */
/* Tunable site constants. These WILL need a visual tuning pass once rendered against real tiles.  */
/* --------------------------------------------------------------------------------------------- */

/** Building latitude (400/410 West Georgia St, Vancouver). Degrees. */
export const SITE_LAT = 49.280513
/** Building longitude. Degrees. */
export const SITE_LON = -123.115893
/**
 * Height (metres above the WGS84 ellipsoid surface) that maps to the scene origin y=0 -- i.e. the
 * floor slab. ReorientationPlugin puts the point (SITE_LAT, SITE_LON, SITE_HEIGHT_M) at the
 * tileset's local origin, so the real ground (ellipsoid height ~0) lands ~SITE_HEIGHT_M BELOW the
 * floor plane. Deloitte Summit's roof is ~92 m: at the literal 14th-floor height (~45 m) the floor
 * plan renders INSIDE the real tower's tile mesh and is occluded, so we lift it ABOVE the roofline
 * (~105 m) so the floor sits visibly ON TOP of the tower instead of hidden inside it. Raise for
 * more clearance above the roof, lower to sink it back toward the building.
 */
export const SITE_HEIGHT_M = 105
/**
 * Rotation (degrees, about +Y) applied to the whole real-world city to line its north up with the
 * floor plan's rendered orientation. ReorientationPlugin lands real north at tileset-local +Z, but
 * App.tsx mirrors the floor plan's north (floor-plan +z) to world -z, so the two are ~180 deg
 * apart before any correction -- plus whatever offset the source floor drawing's "north" carries.
 * Left at 0 deliberately: this is the single knob a visual review turns to spin the real city until
 * its streets line up with the floor plan. Expect a non-zero value (likely near 180) after tuning.
 */
export const SITE_HEADING_DEG = 180

const DEG2RAD = Math.PI / 180

/**
 * DRACO decoder location. Google's Photorealistic 3D Tiles ship as Draco-compressed glTF, so a
 * DRACOLoader is required or every tile fails to decode. Uses Google's own CDN-hosted decoder
 * (same as the library's official google example) -- this app already fetches the tiles
 * themselves from Google, so the decoder shares that trust/network path.
 */
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/v1/decoders/'

export function GoogleTiles({ center }: { center: [number, number] }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)

  // Wrapper group that OWNS tiles.group. ReorientationPlugin centers the tileset on its OWN local
  // origin (the SITE point); this wrapper then places that origin at the floor's world position and
  // applies SITE_HEADING_DEG. Keeping heading/placement on a separate wrapper avoids fighting the
  // transform ReorientationPlugin writes onto tiles.group itself.
  const group = useMemo(() => new THREE.Group(), [])
  const tilesRef = useRef<TilesRenderer | null>(null)
  const [attribution, setAttribution] = useState('')
  const frameCount = useRef(0)

  // Place + orient the wrapper. center is raw floor-plan meters (x, z); z is negated to match
  // App.tsx's north-up mirror (the floor's world position is [centerX, 0, -centerZ]).
  useEffect(() => {
    group.position.set(center[0], 0, -center[1])
    group.rotation.set(0, SITE_HEADING_DEG * DEG2RAD, 0)
  }, [group, center])

  // Build the TilesRenderer + plugins once. Guarded so a bad key / failed fetch never throws into
  // the R3F render loop.
  useEffect(() => {
    const tiles = new TilesRenderer()

    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath(DRACO_DECODER_PATH)

    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: KEY, autoRefreshToken: true }))
    // GLTFExtensionsPlugin wires the DRACO decoder into the tile glTF loader. autoDispose (default
    // true) means tiles.dispose() also disposes dracoLoader, so we do NOT dispose it separately.
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }))
    // Re-orient the globe so the SITE point sits at the tileset's local origin, +Y up. lat/lon are
    // in RADIANS (per the library API); height in metres.
    tiles.registerPlugin(
      new ReorientationPlugin({
        lat: SITE_LAT * DEG2RAD,
        lon: SITE_LON * DEG2RAD,
        height: SITE_HEIGHT_M,
      }),
    )

    tiles.setCamera(camera)
    tiles.setResolutionFromRenderer(camera, gl)

    // A failed tile fetch (auth error, network blip, missing tile) must degrade gracefully, never
    // crash the scene. Log it and carry on -- the floor plan stays fully rendered regardless.
    const onLoadError = (event: { tile: unknown; error: Error; url: string | URL }) => {
      console.warn('[GoogleTiles] tile load error:', String(event.url), event.error)
    }
    tiles.addEventListener('load-error', onLoadError)

    group.add(tiles.group)
    tilesRef.current = tiles

    return () => {
      tiles.removeEventListener('load-error', onLoadError)
      group.remove(tiles.group)
      tiles.dispose()
      tilesRef.current = null
    }
  }, [camera, gl, group])

  // Drive the tile traversal every frame (the documented vanilla-three update loop), and refresh
  // the attribution string occasionally (not every frame -- it changes slowly as tiles stream in).
  useFrame(() => {
    const tiles = tilesRef.current
    if (!tiles) return

    camera.updateMatrixWorld()
    tiles.setResolutionFromRenderer(camera, gl)
    tiles.update()

    frameCount.current += 1
    if (frameCount.current % 30 === 0) {
      const attrs = tiles.getAttributions()
      const text = attrs
        .filter((a) => typeof a.value === 'string')
        .map((a) => a.value as string)
        .filter(Boolean)
        .join('  |  ')
      setAttribution((prev) => (prev === text ? prev : text))
    }
  })

  return (
    <>
      <primitive object={group} />
      {/*
        Required Google attribution. Rendered via drei <Html> (the reliable way to escape R3F's
        reconciler out to the DOM from inside <Canvas>); the inner div is position:fixed so it
        pins to the bottom-left of the viewport regardless of the 3D transform on the <Html>
        wrapper. Muted + small so it never competes with the floor plan, but always visible.
      */}
      <Html>
        <div
          style={{
            position: 'fixed',
            left: 8,
            bottom: 8,
            zIndex: 1000,
            maxWidth: '60vw',
            padding: '2px 8px',
            borderRadius: 4,
            background: 'rgba(0, 0, 0, 0.45)',
            color: 'rgba(255, 255, 255, 0.85)',
            fontFamily: 'sans-serif',
            fontSize: 11,
            lineHeight: 1.3,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {attribution ? `Google  |  ${attribution}` : 'Google'}
        </div>
      </Html>
    </>
  )
}
