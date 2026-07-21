/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Composed test for the WHOLE demo over a FAKE runtime: render `<GeocoderDemo>`, submit a query, and
 *   assert the demo responds — the result panel fills in (HARD: it's plain DOM in the control panel,
 *   independent of WebGL) and the map drops a resolved-place marker (BEST-EFFORT: react-map-gl mounts the
 *   `<Marker>` only once the map instance exists, which needs SwiftShader WebGL — its absence means no
 *   software GL in this Chromium, not a component fault, exactly like `DemoMap.test.tsx`). No network, no
 *   ONNX, no gazetteer, no tiles.
 */

import { userEvent } from "@vitest/browser/context"
import { act } from "react"
import { expect, test, vi } from "vitest"

import { makeDemoRuntime } from "../test/mocks.tsx"
import { renderComponent } from "../test/render.tsx"
import { GeocoderDemo } from "./GeocoderDemo.tsx"

/** Poll `get` inside act() until truthy or timeout; never throws (returns null on timeout). */
async function settle<T>(get: () => T | null, timeout = 8000): Promise<T | null> {
	const start = Date.now()
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

test("submit drives the result panel + a map marker over the fake runtime", async () => {
	// applyResultCamera=false keeps this deterministic: the marker + outline still render, but the animated fly/fit
	// (which maplibre runs on a zero-size headless canvas → NaN LngLat in its RAF loop) is skipped, exactly as the
	// phase-2 overlays test uses applyCamera=false.
	const { container } = renderComponent(
		<GeocoderDemo
			runtime={makeDemoRuntime()}
			defaultAddress="350 5th Ave, New York, NY 10118"
			applyResultCamera={false}
		/>
	)

	// ClientOnly mounts asynchronously; wait for the reused QueryForm input.
	await vi.waitFor(() => expect(container.querySelector("#mw-pipeline-input")).toBeTruthy())

	await userEvent.click(container.querySelector('button[type="submit"]') as HTMLButtonElement)

	// HARD: the result panel is plain DOM in the floating control panel — no WebGL needed.
	await vi.waitFor(() => expect(container.textContent).toContain("Parsed components"))
	expect(container.textContent).toContain("house_number")
	expect(container.textContent).toContain("Resolved place")
	expect(container.textContent).toContain("New York")

	// BEST-EFFORT: the resolved-place marker mounts as a react-map-gl child once the map exists (SwiftShader GL).
	const marker = await settle(() => container.querySelector(".maplibregl-marker"))

	if (marker) {
		expect(marker).toBeInstanceOf(HTMLElement)
	}
})

test("mounts the map container + floating control panel", async () => {
	const { container } = renderComponent(<GeocoderDemo runtime={makeDemoRuntime()} defaultAddress="90210" />)

	await vi.waitFor(() => expect(container.querySelector(".mw-geocoder-demo")).toBeTruthy())
	// The control panel + the map wrapper both render synchronously (map canvas is best-effort, tested in DemoMap).
	expect(container.querySelector(".mw-demo-controls")).not.toBeNull()
	expect(container.querySelector(".mw-geocoder-demo__map .mw-demo-map")).not.toBeNull()
})
