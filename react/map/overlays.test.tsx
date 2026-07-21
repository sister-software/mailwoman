/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-mode render test for the declarative overlays. Mounts `<DemoMap>` (offline stub style) with a
 *   `<ResolvedPlaceLayers>` (built from a fixture render spec) + an `<OverlayLayers>` (a host geojson
 *   overlay) as children, then asserts the outputs on the LIVE map: the resolved-place fill/line layers
 *   and the host overlay layer exist in the style, and the marker element is in the DOM.
 *
 *   Same GL posture as `DemoMap.test.tsx`: the component TREE (`.mw-demo-map`) is asserted synchronously;
 *   everything that needs the WebGL surface (layers via the map ref, the marker element) is awaited
 *   BEST-EFFORT so a Chromium without software WebGL skips those asserts rather than flaking.
 */

import { act } from "react"
import type { MapRef } from "react-map-gl/maplibre"
import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { DemoMap, type DemoMapStyle } from "./DemoMap.tsx"
import { OverlayLayers } from "./OverlayLayers.tsx"
import { computeMapPlaceRenderSpec } from "./place-render.ts"
import { ResolvedPlaceLayers } from "./ResolvedPlaceLayers.tsx"
import type { OverlaySpec } from "./types.ts"

const STUB_STYLE: DemoMapStyle = {
	version: 8,
	name: "overlays-test-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/** A resolved place with a real-extent bbox → the spec draws a fill+line outline and a bounds camera. */
const SPEC = computeMapPlaceRenderSpec({
	id: 1,
	name: "Test City",
	placetype: "locality",
	lat: 40.7128,
	lon: -74.006,
	score: 1,
	bbox: { minLat: 40.6, maxLat: 40.8, minLon: -74.1, maxLon: -73.9 },
})

/** One host overlay: an (empty) geojson source + a fill layer, exercising the `<OverlayLayers>` path. */
const OVERLAY: OverlaySpec = {
	id: "coverage",
	source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
	layers: [{ id: "coverage-fill", type: "fill", source: "coverage", paint: { "fill-color": "#123456" } }],
	label: "Coverage",
}

/** Poll `get` until truthy or `timeout` ms elapse, flushing react-map-gl's async effects inside act(). */
async function settle<T>(get: () => T | null | undefined, timeout = 8000): Promise<T | null> {
	const start = Date.now()
	let found: T | null | undefined = null

	await act(async () => {
		while (Date.now() - start < timeout) {
			found = get()

			if (found) break
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	})

	return found ?? null
}

test("ResolvedPlaceLayers + OverlayLayers render marker + fill/line/overlay layers on the map", async () => {
	let mapRef: MapRef | null = null

	const { container } = renderComponent(
		<DemoMap
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: -74.006, latitude: 40.7128, zoom: 10 }}
			style={{ width: "600px", height: "400px" }}
			mapRef={(ref) => {
				mapRef = ref
			}}
		>
			<ResolvedPlaceLayers spec={SPEC} applyCamera={false} />
			<OverlayLayers overlays={[OVERLAY]} />
		</DemoMap>
	)

	// Component tree — synchronous, independent of WebGL.
	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	// GL surface — best-effort. Its absence means no software WebGL here, not a component fault.
	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (!mapEl) return

	// The marker is a real DOM element react-map-gl mounts inside the map container.
	const marker = await settle(() => container.querySelector(".maplibregl-marker"))
	expect(marker).not.toBeNull()

	// The declarative <Source>/<Layer>s land in the live style once it loads — assert via the map ref.
	const getMap = () => mapRef?.getMap()
	const fill = await settle(() => getMap()?.getLayer("mw-result-fill"))
	expect(fill).toBeTruthy()
	expect(getMap()?.getLayer("mw-result-line")).toBeTruthy()
	expect(getMap()?.getLayer("coverage-fill")).toBeTruthy()
})

test("a null spec renders no marker and no result layers", async () => {
	let mapRef: MapRef | null = null

	const { container } = renderComponent(
		<DemoMap
			mapStyle={STUB_STYLE}
			style={{ width: "600px", height: "400px" }}
			mapRef={(ref) => {
				mapRef = ref
			}}
		>
			<ResolvedPlaceLayers spec={null} />
		</DemoMap>
	)

	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (!mapEl) return

	// Give the style a beat to settle, then confirm nothing was drawn.
	await settle(() => mapRef?.getMap()?.isStyleLoaded() || null, 4000)
	expect(container.querySelector(".maplibregl-marker")).toBeNull()
	expect(mapRef?.getMap()?.getLayer("mw-result-fill")).toBeFalsy()
})
