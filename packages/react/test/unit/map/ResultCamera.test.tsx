/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression tests for the `bounds` camera path — the one that shipped broken and was never exercised.
 *
 *   `<ResultCamera>` passed `duration: animate ? undefined : 0` to `fitBounds`, and maplibre's `Camera.flyTo` branches
 *   on `'duration' in options` rather than on the value: the key survived, `+undefined` made it `NaN`, and the very
 *   first ease frame threw `Invalid LngLat object: (NaN, NaN)` out of the RAF loop with the map still parked at its
 *   start position. Any resolved place that produced a `bounds` target — every admin place with a crisp polygon or a
 *   real-extent bbox — hit it, in every browser, since the phase-2 overlays landed (#1232).
 *
 *   Nothing caught it because the camera is the one thing the map tests turn OFF: `GeocoderDemo.test.tsx` and
 *   `overlays.test.tsx` both pass `applyCamera=false`, and their comments blame "a zero-size headless canvas" for the
 *   NaN LngLat. The canvas was innocent. So the guard here mounts the camera ON, with a bounds target, and lets a
 *   thrown RAF frame fail the run.
 */

import { DemoMap, type DemoMapStyle } from "@mailwoman/react/map/DemoMap"
import type { MapCameraTarget } from "@mailwoman/react/map/place-render"
import { fitBoundsOptionsFor, ResultCamera } from "@mailwoman/react/map/ResultCamera"
import { act } from "react"
import type { MapRef } from "react-map-gl/maplibre"
import { expect, test } from "vitest"

import { renderComponent } from "../../render.tsx"

const STUB_STYLE: DemoMapStyle = {
	version: 8,
	name: "result-camera-test-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/**
 * Manhattan-ish box — a real extent, so `fitBounds` computes a genuine flight rather than the degenerate short-path
 * branch.
 */
const BOUNDS_TARGET: MapCameraTarget = {
	kind: "bounds",
	bounds: [
		[-74.1, 40.6],
		[-73.9, 40.8],
	],
	padding: 40,
}

/**
 * Poll `get` until truthy or `timeout` ms elapse, flushing react-map-gl's async effects inside `act()`.
 */
async function settle<T>(get: () => T | null | undefined, timeout = 8000): Promise<T | null> {
	const start = Date.now()
	let found: T | null | undefined = null

	await act(async () => {
		while (Date.now() - start < timeout) {
			found = get()

			if (found) break

			await new Promise((resolve) => {
				setTimeout(resolve, 50)
			})
		}
	})

	return found ?? null
}

test("an animated fitBounds omits the duration KEY — passing it as undefined is what produced NaN", () => {
	const animated = fitBoundsOptionsFor(40, true)

	// `duration: undefined` would satisfy maplibre's `'duration' in options` test and coerce to NaN. The key must be
	// absent, not merely undefined — `toBeUndefined()` on the value would pass against the bug.
	expect(Object.hasOwn(animated, "duration")).toBe(false)
	expect(animated.padding).toBe(40)

	const jumped = fitBoundsOptionsFor(40, false)
	expect(jumped.duration).toBe(0)
})

test("a bounds target drives the live map to the box without a NaN ease frame", async () => {
	let mapRef: MapRef | null = null

	const { container } = renderComponent(
		<DemoMap
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: 0, latitude: 51.5, zoom: 3 }}
			style={{ width: "600px", height: "400px" }}
			mapRef={(ref) => {
				mapRef = ref
			}}
		>
			<ResultCamera target={BOUNDS_TARGET} />
		</DemoMap>
	)

	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	// GL surface — best-effort, as in the sibling map tests. Its absence means no software WebGL here, not a fault.
	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (!mapEl) return

	// Read the ref lazily: it is assigned in a callback TypeScript cannot see, so reading it directly narrows to `never`.
	const getMap = () => mapRef?.getMap()

	// The map must actually ARRIVE. Under the bug the flight throws on frame 1 and the camera never leaves (0, 51.5) —
	// so a moved center is the assertion, and the thrown RAF frame surfaces as an unhandled error besides.
	const arrived = await settle(() => {
		const center = getMap()?.getCenter()

		return center && Math.abs(center.lng - -74) < 1 && Math.abs(center.lat - 40.7) < 1 ? center : null
	})

	expect(arrived, "the camera never reached the bounds — the ease produced NaN").not.toBeNull()
	expect(Number.isFinite(getMap()?.getZoom())).toBe(true)
})
