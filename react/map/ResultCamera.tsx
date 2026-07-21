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

import { type ReactNode, useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import type { MapCameraTarget } from "./place-render.ts"

export interface ResultCameraProps {
	/** The camera target to animate to. `null` leaves the camera untouched (no result yet). */
	target: MapCameraTarget | null
	/**
	 * Animate (`flyTo`/`fitBounds`) vs jump. @default true. When false, a `center` target jumps with `jumpTo`; a `bounds`
	 * target still uses `fitBounds` (no instantaneous fit exists) but with `duration: 0`.
	 */
	animate?: boolean
}

/** Drive the live map to `target`. No DOM of its own — it is a behavior mounted as a `<Map>` child. */
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

		instance.fitBounds(target.bounds, { padding: target.padding, duration: animate ? undefined : 0 })
	}, [map, target, animate])

	return null
}
