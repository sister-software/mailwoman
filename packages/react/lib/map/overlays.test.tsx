/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-mode render test for the resolved-place and host overlays. The component tree is asserted
 *   synchronously and the WebGL-dependent assertions are awaited best-effort so a Chromium without software
 *   WebGL skips them rather than flaking.
 */

import { MapCanvas, type MapCanvasStyle } from "@mailwoman/react/map/MapCanvas"
import { OverlayLayers } from "@mailwoman/react/map/OverlayLayers"
import { ResolvedPlaceLayers } from "@mailwoman/react/map/ResolvedPlaceLayers"
import { act } from "react"
import type { MapRef } from "react-map-gl/maplibre"
import { expect, test } from "vitest"

import { computeMapPlaceRenderSpec } from "#map/place-render"
import type { OverlaySpec } from "#map/types"

import { renderComponent } from "../../test/render.tsx"

const STUB_STYLE: MapCanvasStyle = {
	version: 8,
	name: "overlays-test-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/**
 * A resolved place with a real-extent bbox, so the spec draws a fill+line outline and a bounds camera.
 */
const SPEC = computeMapPlaceRenderSpec({
	id: 1,
	name: "Test City",
	placetype: "locality",
	lat: 40.7128,
	lon: -74.006,
	score: 1,
	bbox: { minLat: 40.6, maxLat: 40.8, minLon: -74.1, maxLon: -73.9 },
})

/**
 * One host overlay exercising the `<OverlayLayers>` path.
 */
const OVERLAY: OverlaySpec = {
	id: "coverage",
	source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
	layers: [{ id: "coverage-fill", type: "fill", source: "coverage", paint: { "fill-color": "#123456" } }],
	label: "Coverage",
}

/**
 * Poll `get` until truthy or `timeout` ms elapse, flushing react-map-gl's async effects inside act().
 */
async function settle<T>(get: () => T | null, timeout = 8000): Promise<T | null> {
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

test("ResolvedPlaceLayers + OverlayLayers render marker + fill/line/overlay layers on the map", async () => {
	let mapRef: MapRef | null = null

	const { container } = renderComponent(
		<MapCanvas
			mapStyle={STUB_STYLE}
			initialViewState={{ longitude: -74.006, latitude: 40.7128, zoom: 10 }}
			style={{ width: "600px", height: "400px" }}
			mapRef={(ref) => {
				mapRef = ref
			}}
		>
			<ResolvedPlaceLayers spec={SPEC} applyCamera={false} />
			<OverlayLayers overlays={[OVERLAY]} />
		</MapCanvas>
	)

	// Component tree: synchronous, independent of WebGL.
	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	// GL surface, best-effort: its absence means no software WebGL here rather than a component fault.
	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (!mapEl) return

	// The marker is a DOM element react-map-gl mounts inside the map container.
	const marker = await settle(() => container.querySelector(".maplibregl-marker"))
	expect(marker).not.toBeNull()

	// The declarative `<Source>`/`<Layer>`s land in the live style once it loads.
	// Assert via the map ref.
	const getMap = () => mapRef?.getMap()
	const fill = await settle(() => getMap()?.getLayer("mw-result-fill"))
	expect(fill).toBeTruthy()
	expect(getMap()?.getLayer("mw-result-line")).toBeTruthy()
	expect(getMap()?.getLayer("coverage-fill")).toBeTruthy()
})

test("a null spec renders no marker and no result layers", async () => {
	let mapRef: MapRef | null = null

	const { container } = renderComponent(
		<MapCanvas
			mapStyle={STUB_STYLE}
			style={{ width: "600px", height: "400px" }}
			mapRef={(ref) => {
				mapRef = ref
			}}
		>
			<ResolvedPlaceLayers spec={null} />
		</MapCanvas>
	)

	expect(container.querySelector(".mw-demo-map")).not.toBeNull()

	const mapEl = await settle(() => container.querySelector(".maplibregl-map"))

	if (!mapEl) return

	// Read the ref lazily: it is assigned in a callback TypeScript cannot see,
	// so reading it directly narrows it to `never`.
	const getMap = () => mapRef?.getMap()

	// Give the style a beat to settle, then confirm no overlay was drawn.
	await settle(() => getMap()?.isStyleLoaded() || null, 4000)
	expect(container.querySelector(".maplibregl-marker")).toBeNull()
	expect(getMap()?.getLayer("mw-result-fill")).toBeFalsy()
})
