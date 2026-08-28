/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<ResultCamera>` — applies the {@link MapCameraTarget} a {@link MapPlaceRenderSpec} computes, by
 *   animating the live map to it. This is the ONE deliberately-imperative touch in the phase-2 overlays,
 *   and it is justified: maplibre exposes animated camera moves (`flyTo`) and viewport-fitting
 *   (`fitBounds`, which needs the map's PIXEL dimensions + padding) ONLY imperatively — react-map-gl has
 *   no declarative prop for "animate to these bounds". It is applied the v8-idiomatic way, through
 *   `useMap()` (exactly as `DashboardMap`/`GeoJSONClipboardLayer` reach the map), never a threaded handle.
 *
 *   A consumer that prefers a hard, declarative jump can instead feed the target through
 *   {@link cameraToViewState} into a controlled `<DemoMap viewState>` and skip this component — the
 *   `center` case has that declarative path; only `bounds` strictly requires this. Renders nothing.
 *
 *   `target` is expected to be the STABLE, memoized `camera` off a `useMapPlaceRender` spec, so listing it
 *   as the effect dependency re-runs the camera move exactly when the resolved place changes — no
 *   value-key dance, no dependency-lint suppression.
 */

import type { FitBoundsOptions } from "maplibre-gl"
import { type ReactNode, useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import type { MapCameraTarget } from "./place-render.ts"

/**
 * The `fitBounds` options for a `bounds` target — and the reason this is a named function rather than an object literal
 * at the call site.
 *
 * `duration` is present ONLY on the non-animated path, and its ABSENCE on the animated one is required. maplibre's
 * `Camera.flyTo` (which `fitBounds` funnels into via `_fitInternal`) branches on `'duration' in options`, not on the
 * value: an explicitly-passed `duration: undefined` therefore survives the key test and is coerced with `+undefined` →
 * `NaN`. Every ease frame then computes `k = easing(elapsed / NaN)` → `NaN`, the flight-path math yields a `NaN` world
 * coordinate, and the FIRST frame throws `Invalid LngLat object: (NaN, NaN)` out of the RAF loop — before the map has
 * moved at all, and with no `move` event to notice it by.
 *
 * Measured 2026-08-05 against maplibre-gl 5.24.0, same bounds and same map: `{padding: 40, duration: undefined}` →
 * `map._easeOptions.duration = NaN` + the throw; `{padding: 40}` → `3937.7 ms` + a normal flight. So pass the key or
 * don't — never pass it holding `undefined`.
 */
export function fitBoundsOptionsFor(padding: number, animate: boolean): FitBoundsOptions {
	return animate ? { padding } : { padding, duration: 0 }
}

export interface ResultCameraProps {
	/**
	 * The camera target to animate to. `null` leaves the camera untouched (no result yet).
	 */
	target: MapCameraTarget | null
	/**
	 * Animate (`flyTo`/`fitBounds`) vs jump. @default true. When false, a `center` target jumps with `jumpTo`; a `bounds`
	 * target still uses `fitBounds` (no instantaneous fit exists) but with `duration: 0`.
	 */
	animate?: boolean
}

/**
 * Drive the live map to `target`. No DOM of its own — it is a behavior mounted as a `<Map>` child.
 */
export function ResultCamera({ target, animate = true }: ResultCameraProps): ReactNode {
	const map = useMap()

	useEffect(() => {
		const instance = map.current?.getMap()

		if (!instance || !target) return

		if (target.kind === "center") {
			if (animate) {
				instance.flyTo({ center: target.center, zoom: target.zoom })
			} else {
				instance.jumpTo({ center: target.center, zoom: target.zoom })
			}

			return
		}

		instance.fitBounds(target.bounds, fitBoundsOptionsFor(target.padding, animate))
	}, [map, target, animate])

	return null
}
