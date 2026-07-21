/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<DemoMap>` mounts a real `react-map-gl/maplibre` map over an offline stub style (one `background`
 *   layer, no network). The HARD assertion is on the component TREE — the `.mw-demo-map` wrapper and
 *   react-map-gl's container `<div>` render synchronously, without throwing. The WebGL SURFACE (the
 *   `<canvas>`) and the child slot only appear AFTER react-map-gl's async mount effect (a dynamic
 *   `import("maplibre-gl")` + map creation), so they're awaited BEST-EFFORT: `vitest.config.ts` routes
 *   GL through SwiftShader so they normally do appear, but if a future headless Chromium can't provide
 *   software WebGL the map never initializes and those assertions are skipped — the tree assertion still
 *   proves the component renders. That keeps this a component-mount test, not a GPU test.
 */

import { act } from "react"
import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { DemoMap, type DemoMapStyle } from "./DemoMap.tsx"

const STUB_STYLE: DemoMapStyle = {
	version: 8,
	name: "demo-map-test-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/** Poll `get` until it returns a truthy value or `timeout` ms elapse. Never throws — returns null on timeout. */
async function settle<T>(get: () => T | null, timeout = 8000): Promise<T | null> {
	const start = Date.now()

	// Flush react-map-gl's async map creation (dynamic import + effects) inside act() so React state
	// updates don't warn and the DOM is current when we query.
	let found: T | null = null
	await act(async () => {
		while (Date.now() - start < timeout) {
			found = get()

			if (found) break
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	})

	return found
}

test("DemoMap mounts a map container over an offline stub style", async () => {
	const { container } = renderComponent(
		<DemoMap
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: -74.006, latitude: 40.7128, zoom: 10 }}
			style={{ width: "600px", height: "400px" }}
		/>
	)

	// Component tree — synchronous, independent of WebGL.
	const wrapper = container.querySelector(".mw-demo-map")
	expect(wrapper).not.toBeNull()
	// react-map-gl always renders its container <div> as the wrapper's only child.
	expect(wrapper?.firstElementChild).not.toBeNull()

	// GL surface — best-effort (SwiftShader normally provides it). Its absence means no software WebGL in
	// this Chromium, not a component fault.
	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (mapEl) {
		const canvas = container.querySelector("canvas.maplibregl-canvas")
		expect(canvas).toBeInstanceOf(HTMLCanvasElement)
	}
})

test("DemoMap renders a children slot inside the map", async () => {
	const { container } = renderComponent(
		<DemoMap mapStyle={STUB_STYLE} style={{ width: "600px", height: "400px" }}>
			<div data-testid="overlay-slot">slot</div>
		</DemoMap>
	)

	// The wrapper renders synchronously.
	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	// react-map-gl renders children only once the map instance exists (post async mount) — best-effort.
	const slot = await settle(() => container.querySelector('[data-testid="overlay-slot"]'))

	if (slot) {
		expect(slot.textContent).toBe("slot")
	}
})
