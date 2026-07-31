import { useEffect, useRef, useState, type RefObject } from 'react'
import type { MapControls as MapControlsImpl } from 'three-stdlib'

/**
 * Task 5.4: kiosk / big-screen mode, gated entirely behind a `?kiosk=1` URL param so the
 * normal dev/rehearsal client (plain http://localhost:5173, no param) is completely
 * unaffected by anything in this file. Three independent concerns live here, one per hook,
 * matching the task's three requirements:
 *
 *  - useIsKiosk()          -- reads the URL once at load.
 *  - useKioskFullscreen()  -- first-gesture-gated Fullscreen API request.
 *  - useIdleAutoOrbit()    -- drives <MapControls>'s own built-in autoRotate on/off based on
 *                             how long it's been since the last pointer/wheel/touch
 *                             interaction, handing manual control back immediately on the
 *                             next one.
 *
 * There's no dev-only debug UI in App.tsx or scene/ today (checked: no overlay/stats/debug
 * components exist yet), so requirement (b) of the task -- "hide dev-only UI chrome" -- has
 * nothing to hide right now. isKiosk is returned as a plain boolean so any future debug
 * overlay can trivially gate on `!isKiosk` when one gets added.
 */

const KIOSK_PARAM = 'kiosk'

/** Reads `?kiosk=1` from the URL the page was loaded with, once, on first render. */
export function useIsKiosk(): boolean {
  const [isKiosk] = useState(
    () => new URLSearchParams(window.location.search).get(KIOSK_PARAM) === '1',
  )
  return isKiosk
}

/**
 * Requests the Fullscreen API on the first user gesture after mount. Browsers only grant
 * `requestFullscreen()` when it's called synchronously inside a real user-gesture handler
 * (click/tap/keypress) -- calling it on page load or from a timer is refused every time. A
 * kiosk browser is typically opened via a script/URL with no click at all, so this listens at
 * the window level for the first `pointerdown` (covers both mouse clicks and touch taps) and
 * fires the request from directly inside that handler.
 *
 * `requestFullscreen()` REJECTS its promise rather than throwing when denied -- e.g. no
 * gesture yet, the tab is embedded in an iframe without `allow="fullscreen"`, or the browser
 * chrome itself blocks it. The `.catch(() => {})` swallows that so kiosk mode still renders
 * (just as a normal full-window tab instead of true OS-level fullscreen) instead of crashing
 * or spamming console errors. The listener is never removed while in kiosk mode, so if the
 * first gesture's request is refused, the next tap/click tries again.
 */
export function useKioskFullscreen(isKiosk: boolean): void {
  useEffect(() => {
    if (!isKiosk) return

    const requestFullscreen = () => {
      if (document.fullscreenElement) return
      document.documentElement.requestFullscreen().catch(() => {
        // Denied without a click, blocked by embedding policy, or unsupported in this
        // browser -- ignore and wait for the next gesture.
      })
    }

    window.addEventListener('pointerdown', requestFullscreen)
    return () => window.removeEventListener('pointerdown', requestFullscreen)
  }, [isKiosk])
}

/**
 * Seconds of no pointer/wheel/touch input before the scripted camera orbit takes over.
 * Picked in the middle of the 15-30s range that reads well for an unattended demo screen:
 * long enough that anyone actively driving the rehearsal (dragging, scrolling to zoom) never
 * sees it kick in, short enough that the screen doesn't sit dead-still for a full 30s the
 * moment nobody's touching it.
 */
export const IDLE_THRESHOLD_MS = 20_000

/**
 * three-stdlib's OrbitControls (which MapControls extends) advances the camera's azimuth by
 * `2*Math.PI/60/60 * autoRotateSpeed` radians on every `controls.update()` call -- and drei's
 * <MapControls> already calls `update()` once per rendered R3F frame (see
 * node_modules/@react-three/drei/core/MapControls.js: `useFrame(() => controls.update(), -1)`),
 * so at F frames/sec the period works out to `3600 / (autoRotateSpeed * F)` seconds per full
 * revolution. At a typical 60fps display that's ~4 minutes per revolution at this speed --
 * slow enough to read as ambient idle motion, not a distracting spin. This scales with the
 * kiosk screen's actual refresh rate, so treat it as a starting point to eyeball on the real
 * hardware and retune, not an exact clock (see the manual verification steps).
 */
const IDLE_AUTO_ROTATE_SPEED = 0.25

/**
 * Toggles MapControls' built-in `autoRotate` based on idle time, using the library's own
 * feature rather than a hand-rolled per-frame azimuth increment -- MapControls already
 * exposes `autoRotate`/`autoRotateSpeed` (inherited from OrbitControls) and already runs
 * `update()` every frame regardless, so flipping one boolean is the entire "scripted camera"
 * implementation; a manual azimuth-increment loop would just be re-implementing this.
 *
 * Deliberately does NOT disable MapControls itself, ever -- autoRotate only takes effect
 * inside OrbitControls' own update() when its internal interaction state is idle (see
 * three-stdlib's OrbitControls.js: `if (scope.autoRotate && state === STATE.NONE)`), so a
 * drag/pan/zoom already in progress is untouched, and rehearsal/manual override always works.
 *
 * Returns `onInteractionStart`/`onInteractionEnd`, meant to be passed straight to
 * <MapControls onStart={...} onEnd={...}>. Those fire from three-stdlib's OrbitControls
 * itself on pointerdown (mouse AND touch -- it unifies both through the Pointer Events API)
 * and on wheel, i.e. exactly the input set a touchscreen kiosk + a mouse-driven rehearsal
 * both use. `onInteractionStart` turns autoRotate off in the SAME tick the gesture begins, so
 * manual control resumes immediately rather than waiting for the next idle-check tick.
 */
export function useIdleAutoOrbit(
  isKiosk: boolean,
  controlsRef: RefObject<MapControlsImpl | null>,
): { onInteractionStart: () => void; onInteractionEnd: () => void } {
  const lastInteractionRef = useRef<number>(Date.now())

  useEffect(() => {
    if (!isKiosk) return

    const interval = window.setInterval(() => {
      const controls = controlsRef.current
      if (!controls) return
      const idleForMs = Date.now() - lastInteractionRef.current
      controls.autoRotateSpeed = IDLE_AUTO_ROTATE_SPEED
      controls.autoRotate = idleForMs >= IDLE_THRESHOLD_MS
    }, 1000)

    return () => window.clearInterval(interval)
  }, [isKiosk, controlsRef])

  const onInteractionStart = () => {
    lastInteractionRef.current = Date.now()
    const controls = controlsRef.current
    if (controls) controls.autoRotate = false
  }
  const onInteractionEnd = () => {
    lastInteractionRef.current = Date.now()
  }

  return { onInteractionStart, onInteractionEnd }
}
