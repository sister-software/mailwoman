/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PURE render-spec tests — bare node, no map. They pin the decision cascade that replaces the demo's
 *   imperative redraw effect: which outline + camera each resolved-place shape produces, the tier-over-
 *   polygon precedence, the postcode-with/without-bbox split, the bare-point fallthrough, and the
 *   declarative `cameraToViewState` path. A fake `ResolvedMapPlace` stands in for the runtime result.
 */

import { expect, test } from "vitest"

import { cameraToViewState, computeMapPlaceRenderSpec, type ResolvedMapPlace } from "./place-render.ts"

/** A minimal resolved place; spread over with the fields a given branch needs. */
function place(overrides: Partial<ResolvedMapPlace>): ResolvedMapPlace {
	return { id: 1, name: "Somewhere", placetype: "locality", lat: 40, lon: -74, score: 1, ...overrides }
}

test("street address_point tier → exact-radius circle + fly to zoom 17", () => {
	const spec = computeMapPlaceRenderSpec(place({ tier: "address_point", uncertaintyM: 10 }))
	expect(spec.markers).toEqual([[-74, 40]])
	expect(spec.outline?.type).toBe("Polygon")
	expect(spec.camera).toEqual({ kind: "center", center: [-74, 40], zoom: 17 })
})

test("street interpolated tier → fly to the looser zoom 15", () => {
	const spec = computeMapPlaceRenderSpec(place({ tier: "interpolated", uncertaintyM: 120 }))
	expect(spec.camera).toEqual({ kind: "center", center: [-74, 40], zoom: 15 })
})

test("a pre-fetched crisp polygon → draw it and fit its bounds (padding 40)", () => {
	const geometry = {
		type: "Polygon" as const,
		coordinates: [
			[
				[-74, 40],
				[-73, 40],
				[-73, 41],
				[-74, 41],
				[-74, 40],
			],
		],
	}
	const spec = computeMapPlaceRenderSpec(place({ geometry }))
	expect(spec.outline).toBe(geometry)
	expect(spec.camera).toEqual({
		kind: "bounds",
		bounds: [
			[-74, 40],
			[-73, 41],
		],
		padding: 40,
	})
})

test("street tier takes precedence over a pre-fetched polygon", () => {
	const geometry = { type: "Polygon" as const, coordinates: [[[0, 0]]] }
	const spec = computeMapPlaceRenderSpec(place({ tier: "address_point", uncertaintyM: 10, geometry }))
	// The street path returns a CENTER camera; the polygon path would have returned BOUNDS.
	expect(spec.camera.kind).toBe("center")
	expect(spec.outline).not.toBe(geometry)
})

test("anchor-centroid postcode (no bbox) → ~3 km circle + fly to zoom 11", () => {
	const spec = computeMapPlaceRenderSpec(place({ placetype: "postcode" }))
	expect(spec.outline?.type).toBe("Polygon")
	expect(spec.camera).toEqual({ kind: "center", center: [-74, 40], zoom: 11 })
})

test("a bbox with real extent → bbox-sized circle + fit the bbox", () => {
	const bbox = { minLat: 39.9, maxLat: 40.1, minLon: -74.1, maxLon: -73.9 }
	const spec = computeMapPlaceRenderSpec(place({ bbox }))
	expect(spec.outline?.type).toBe("Polygon")
	expect(spec.camera).toEqual({
		kind: "bounds",
		bounds: [
			[-74.1, 39.9],
			[-73.9, 40.1],
		],
		padding: 40,
	})
})

test("a postcode that DOES carry a bbox takes the bbox path, not the anchor-centroid circle", () => {
	const bbox = { minLat: 39.9, maxLat: 40.1, minLon: -74.1, maxLon: -73.9 }
	const spec = computeMapPlaceRenderSpec(place({ placetype: "postcode", bbox }))
	expect(spec.camera.kind).toBe("bounds")
})

test("a sub-visible bbox (span ≤ 0.001°) falls through to a bare point at zoom 12", () => {
	const bbox = { minLat: 40, maxLat: 40.0005, minLon: -74, maxLon: -73.9995 }
	const spec = computeMapPlaceRenderSpec(place({ bbox }))
	expect(spec.outline).toBeNull()
	expect(spec.camera).toEqual({ kind: "center", center: [-74, 40], zoom: 12 })
})

test("no bbox, no tier, non-postcode → bare point at zoom 12", () => {
	const spec = computeMapPlaceRenderSpec(place({}))
	expect(spec.outline).toBeNull()
	expect(spec.camera).toEqual({ kind: "center", center: [-74, 40], zoom: 12 })
})

test("cameraToViewState reshapes a center target and returns null for a bounds target", () => {
	expect(cameraToViewState({ kind: "center", center: [-74, 40], zoom: 12 })).toEqual({
		longitude: -74,
		latitude: 40,
		zoom: 12,
	})
	expect(
		cameraToViewState({
			kind: "bounds",
			bounds: [
				[-74, 40],
				[-73, 41],
			],
			padding: 40,
		})
	).toBeNull()
})
