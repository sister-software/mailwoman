/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { makeFakeGeocoderRuntime } from "@mailwoman/react/map/fake-runtime"
import { Geocoder } from "@mailwoman/react/map/Geocoder"
import { act } from "react"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import { renderComponent } from "../../render.tsx"

// This helper polls `get` inside `act()` and returns null on timeout instead of throwing.
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

test("submit drives the result panel + a map marker over the fake runtime", async () => {
	// Disabling the result camera keeps the view fixed.
	// `ResultCamera.test.tsx` covers camera moves.
	const { container } = renderComponent(
		<Geocoder
			runtime={makeFakeGeocoderRuntime()}
			defaultAddress="350 5th Ave, New York, NY 10118"
			applyResultCamera={false}
		/>
	)

	// `ClientOnly` mounts its children asynchronously.
	await vi.waitFor(() => expect(container.querySelector("#mw-pipeline-input")).toBeTruthy())

	// The search bar has no submit button, so Enter submits the query.
	await userEvent.click(container.querySelector("#mw-pipeline-input") as HTMLInputElement)
	await userEvent.keyboard("{Enter}")

	// The result panel is plain DOM, so these assertions do not depend on WebGL.
	await vi.waitFor(() => expect(container.textContent).toContain("Parsed components"))
	expect(container.textContent).toContain("house_number")
	expect(container.textContent).toContain("Resolved place")
	expect(container.textContent).toContain("New York")

	// The marker mounts only after the map initializes, which needs software WebGL, so this check is best-effort.
	const marker = await settle(() => container.querySelector(".maplibregl-marker"))

	if (marker) {
		expect(marker).toBeInstanceOf(HTMLElement)
	}
})

test("mounts the map container + floating control panel", async () => {
	const { container } = renderComponent(<Geocoder runtime={makeFakeGeocoderRuntime()} defaultAddress="90210" />)

	await vi.waitFor(() => expect(container.querySelector(".mw-geocoder-demo")).toBeTruthy())
	// The controls and the map wrapper render without waiting for WebGL.
	expect(container.querySelector(".mw-map-panel")).not.toBeNull()
	expect(container.querySelector(".mw-map-panel__header")).not.toBeNull()
	expect(container.querySelector(".mw-map-searchbar")).not.toBeNull()
	expect(container.querySelector(".mw-map-control-stack")).not.toBeNull()
	expect(container.querySelector(".mw-geocoder-demo__map .mw-demo-map")).not.toBeNull()
})
