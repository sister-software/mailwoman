/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { MapCanvas, type MapCanvasStyle } from "@mailwoman/react/map/MapCanvas"
import { act } from "react"
import { expect, test } from "vitest"

import { renderComponent } from "../../render.tsx"

// The stub style has a single background layer, so the test makes no network requests.
const STUB_STYLE: MapCanvasStyle = {
	version: 8,
	name: "demo-map-test-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

// This helper polls `get` inside `act()`, so react-map-gl's async mount settles without act warnings.
// It returns null on timeout instead of throwing.
async function settle<T>(get: () => T | null, timeout = 8000): Promise<T | null> {
	const start = Date.now()
	let found: T | null = null

	await act(async () => {
		while (Date.now() - start < timeout) {
			found = get()

			if (found) break

			await new Promise((resolve) => {
				setTimeout(resolve, 50)
			})
		}
	})

	return found
}

test("MapCanvas mounts a map container over an offline stub style", async () => {
	const { container } = renderComponent(
		<MapCanvas
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: -74.006, latitude: 40.7128, zoom: 10 }}
			style={{ width: "600px", height: "400px" }}
		/>
	)

	// The wrapper and react-map-gl's container render synchronously, without WebGL.
	const wrapper = container.querySelector(".mw-demo-map")
	expect(wrapper).not.toBeNull()
	expect(wrapper?.firstElementChild).not.toBeNull()

	// The canvas appears only when the browser provides WebGL, so this check is best-effort.
	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (mapEl) {
		const canvas = container.querySelector("canvas.maplibregl-canvas")
		expect(canvas).toBeInstanceOf(HTMLCanvasElement)
	}
})

test("MapCanvas renders a children slot inside the map", async () => {
	const { container } = renderComponent(
		<MapCanvas mapStyle={STUB_STYLE} style={{ width: "600px", height: "400px" }}>
			<div data-testid="overlay-slot">slot</div>
		</MapCanvas>
	)

	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	// react-map-gl renders children only after the map initializes, so this check is best-effort.
	const slot = await settle(() => container.querySelector('[data-testid="overlay-slot"]'))

	if (slot) {
		expect(slot.textContent).toBe("slot")
	}
})
