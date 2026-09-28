/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression tests for the `bounds` camera path: an animated `fitBounds` must omit the `duration` KEY, since
 *   maplibre's `Camera.flyTo` branches on `'duration' in options` and an undefined value coerces to `NaN`.
 */

import { MapCanvas, type MapCanvasStyle } from "@mailwoman/react/map/MapCanvas"
import type { MapCameraTarget } from "@mailwoman/react/map/place-render"
import { fitBoundsOptionsFor, ResultCamera } from "@mailwoman/react/map/ResultCamera"
import { act } from "react"
import type { MapRef } from "react-map-gl/maplibre"
import { expect, test } from "vitest"

import { renderComponent } from "../../render.tsx"

const STUB_STYLE: MapCanvasStyle = {
	version: 8,
	name: "result-camera-test-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/**
 * A real-extent box, so `fitBounds` computes a genuine flight rather than the degenerate short-path branch.
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

	// The key must be absent rather than merely undefined: `duration: undefined` satisfies maplibre's `'duration' in options` test and coerces to `NaN`, and `toBeUndefined()` would pass against the bug.
	expect(Object.hasOwn(animated, "duration")).toBe(false)
	expect(animated.padding).toBe(40)

	const jumped = fitBoundsOptionsFor(40, false)
	expect(jumped.duration).toBe(0)
})

test("a bounds target drives the live map to the box without a NaN ease frame", async () => {
	let mapRef: MapRef | null = null

	const { container } = renderComponent(
		<MapCanvas
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: 0, latitude: 51.5, zoom: 3 }}
			style={{ width: "600px", height: "400px" }}
			mapRef={(ref) => {
				mapRef = ref
			}}
		>
			<ResultCamera target={BOUNDS_TARGET} />
		</MapCanvas>
	)

	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	// GL surface, best-effort as in the sibling map tests: its absence means no software WebGL here rather than a fault.
	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (!mapEl) return

	// Read the ref lazily: it is assigned in a callback TypeScript cannot see, so reading it directly narrows to `never`.
	const getMap = () => mapRef?.getMap()

	// Under the bug the flight throws on frame 1 and the camera never leaves (0, 51.5), so a moved center is the assertion.
	const arrived = await settle(() => {
		const center = getMap()?.getCenter()

		return center && Math.abs(center.lng - -74) < 1 && Math.abs(center.lat - 40.7) < 1 ? center : null
	})

	expect(arrived, "the camera never reached the bounds — the ease produced NaN").not.toBeNull()
	expect(Number.isFinite(getMap()?.getZoom())).toBe(true)
})
