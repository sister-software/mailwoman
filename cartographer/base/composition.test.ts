/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { createLightSpec, createSkySpec, StyleSpecificationComposer } from "./composition.js"

//#region createLightSpec

test("createLightSpec: returns the house defaults when called bare", () => {
	expect(createLightSpec()).toEqual({
		color: "white",
		intensity: 0.85,
		anchor: "viewport",
		position: [10, 20, -5],
	})
})

test("createLightSpec: an override shadows the matching default key", () => {
	const spec = createLightSpec({ intensity: 0.5 })

	expect(spec.intensity).toBe(0.5)
	// non-overridden defaults survive
	expect(spec.color).toBe("white")
	expect(spec.anchor).toBe("viewport")
})

test("createLightSpec: overriding position replaces the whole tuple", () => {
	expect(createLightSpec({ position: [1, 2, 3] }).position).toEqual([1, 2, 3])
})

//#endregion

//#region createSkySpec

test("createSkySpec: returns the house atmospheric defaults when called bare", () => {
	expect(createSkySpec()).toEqual({
		"sky-color": "#000535",
		"horizon-color": "hsl(54deg 100% 16%)",
		"fog-color": "hsl(54deg 100% 5%)",
		"sky-horizon-blend": 0.75,
		"horizon-fog-blend": 0.75,
		"fog-ground-blend": 0.1,
	})
})

test("createSkySpec: an override shadows only the named key", () => {
	const spec = createSkySpec({ "sky-color": "#123456" })

	expect(spec["sky-color"]).toBe("#123456")
	expect(spec["fog-ground-blend"]).toBe(0.1) // untouched default
})

//#endregion

//#region StyleSpecificationComposer — construction

test("Composer: light/sky default to the house specs when unset", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })

	expect(composer.light).toEqual(createLightSpec())
	expect(composer.sky).toEqual(createSkySpec())
})

test("Composer: partial light/sky options merge over the defaults", () => {
	const composer = new StyleSpecificationComposer({
		sources: {},
		light: { intensity: 0.3 },
		sky: { "sky-color": "#abcdef" },
	})

	expect(composer.light.intensity).toBe(0.3)
	expect(composer.light.color).toBe("white") // default preserved
	expect(composer.sky["sky-color"]).toBe("#abcdef")
})

// Terrain + DEM-source tests parked (mobile performance): the `terrain` getter and the terrain DEM
// source are commented out in `composition.ts`. Re-enable the code and these tests together when DEM
// is reconsidered. (The hillshade DEM source is still injected.)
/*
test("Composer: terrain source defaults to the terrain tileset id", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })

	expect(composer.terrain.source).toBe("terrain")
})

test("Composer: a terrain override merges over the default source", () => {
	const composer = new StyleSpecificationComposer({ sources: {}, terrain: { exaggeration: 1.5 } })

	expect(composer.terrain.source).toBe("terrain") // default kept
	expect(composer.terrain.exaggeration).toBe(1.5)
})

test("Composer: injects DEM sources for terrain + hillshade alongside the caller's sources", () => {
	const userSource = { type: "vector", url: "https://example.test/tiles.json" } as const
	const composer = new StyleSpecificationComposer({ sources: { mine: userSource } })

	// the caller's source + the runtime-injected DEM sources aren't all in the static source-record type.
	const sources = composer.sources as Record<string, unknown>
	expect(sources.mine).toEqual(userSource)
	expect(sources.terrain).toMatchObject({ type: "raster-dem", encoding: "terrarium" })
	expect(sources.hillshade).toMatchObject({ type: "raster-dem", encoding: "terrarium" })
})
*/

//#endregion

//#region StyleSpecificationComposer — layers

test("Composer.layers: exposes the base layer list as an array", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })

	expect(Array.isArray(composer.layers)).toBe(true)
	expect(composer.layers.length).toBeGreaterThan(0)
})

test("Composer.layers: an inserted layer is present in the composed list", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })
	// `insert` requires an anchor (`beforeID`/`afterID`) — anchor against an existing base layer.
	const anchorID = composer.layers[0]!.id

	const withCustom = new StyleSpecificationComposer({
		sources: {},
		layers: [
			{
				id: "mw-test-layer",
				type: "background",
				paint: { "background-color": "#ff0000" },
				afterID: anchorID,
			},
		],
	})

	const inserted = withCustom.layers.find((l) => l.id === "mw-test-layer")
	expect(inserted).toBeDefined()
	expect(inserted!.type).toBe("background")
})

test("Composer.layers: an inserted layer sits immediately after its anchor", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })
	const anchorID = composer.layers[0]!.id

	const withCustom = new StyleSpecificationComposer({
		sources: {},
		layers: [{ id: "mw-anchored-layer", type: "background", paint: {}, afterID: anchorID }],
	})

	const ids = withCustom.layers.map((l) => l.id)
	const anchorIdx = ids.indexOf(anchorID)
	expect(anchorIdx).toBeGreaterThanOrEqual(0)
	expect(ids[anchorIdx + 1]).toBe("mw-anchored-layer")
})

//#endregion

//#region StyleSpecificationComposer — serialization

test("Composer.toJSON: emits a v8 style with the self-host glyph + sprite endpoints", () => {
	const style = new StyleSpecificationComposer({ sources: {} }).toJSON()

	expect(style.version).toBe(8)
	expect(style.glyphs).toBe("https://public.sister.software/protomaps/fonts/{fontstack}/{range}.pbf")
	expect(style.sprite).toBe("https://public.sister.software/protomaps/sprites/v4/light")
})

test("Composer.toJSON: carries the composed light, sky, terrain, sources and layers through", () => {
	const composer = new StyleSpecificationComposer({ sources: {}, light: { intensity: 0.2 } })
	const style = composer.toJSON()

	expect(style.light).toEqual(createLightSpec(composer.light))
	expect(style.sky).toEqual(createSkySpec(composer.sky))
	expect(style.terrain).toEqual(composer.terrain)
	expect(style.sources).toBe(composer.sources)
	expect(style.layers).toEqual(composer.layers)
})

test("Composer.toJS: is an alias of toJSON", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })

	expect(composer.toJS()).toEqual(composer.toJSON())
})

test("Composer: two instances from the shared BaseLayers have independent layer lists", () => {
	// Regression for the shared-mutable-link bug: LayerSpecificationList now copies its input, so
	// constructing a second composer no longer rewrites the first's kNext/kPrev links in place.
	const a = new StyleSpecificationComposer({ sources: {} })
	const baseCount = a.layers.length
	const b = new StyleSpecificationComposer({ sources: {} })
	expect(b.layers.length).toBe(baseCount) // b built a full list, not a corrupted remnant
	expect(a.layers.length).toBe(baseCount) // a's list wasn't mutated by b's construction
})

//#endregion
