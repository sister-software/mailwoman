import { createLightSpec, createSkySpec, StyleSpecificationComposer } from "@mailwoman/cartographer/base/composition"
import { expect, test } from "vitest"

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

	expect(spec.color).toBe("white")
	expect(spec.anchor).toBe("viewport")
})

test("createLightSpec: overriding position replaces the whole tuple", () => {
	expect(createLightSpec({ position: [1, 2, 3] }).position).toEqual([1, 2, 3])
})

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
	expect(spec["fog-ground-blend"]).toBe(0.1)
})

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
	expect(composer.light.color).toBe("white")
	expect(composer.sky["sky-color"]).toBe("#abcdef")
})

/* oxlint-disable vitest/no-commented-out-tests -- parked deliberately. see the note above */

test("Composer.layers: exposes the base layer list as an array", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })

	expect(Array.isArray(composer.layers)).toBe(true)
	expect(composer.layers.length).toBeGreaterThan(0)
})

test("Composer.layers: an inserted layer is present in the composed list", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })

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

test("Composer.toJSON: emits a v8 style with the self-host glyph + sprite endpoints", () => {
	const style = new StyleSpecificationComposer({ sources: {} }).toJSON()

	expect(style.version).toBe(8)
	expect(style.glyphs).toBe("https://public.mailwoman.ai/protomaps/fonts/{fontstack}/{range}.pbf")
	expect(style.sprite).toBe("https://public.mailwoman.ai/protomaps/sprites/v4/light")
})

test("Composer.toJSON: carries the composed light, sky, terrain, sources and layers through", () => {
	const composer = new StyleSpecificationComposer({ sources: {}, light: { intensity: 0.2 } })
	const style = composer.toJSON()

	expect(style.light).toEqual(createLightSpec(composer.light))
	expect(style.sky).toEqual(createSkySpec(composer.sky))

	expect(style.sources).toBe(composer.sources)
	expect(style.layers).toEqual(composer.layers)
})

test("Composer.toJS: is an alias of toJSON", () => {
	const composer = new StyleSpecificationComposer({ sources: {} })

	expect(composer.toJS()).toEqual(composer.toJSON())
})

test("Composer: a composition with no overrides is the Earth style: base layers, the terrarium hillshade source, the sprite", () => {
	const style = new StyleSpecificationComposer({ sources: {} }).toJSON()

	expect(style.sprite).toMatch(/protomaps\/sprites\/v4\/light$/u)
	expect(Object.keys(style.sources)).toContain("hillshade")
	expect(style.layers.length).toBeGreaterThan(5)
})

test("Composer: a composition can bring its own base layers without hillshade source and no sprite", () => {
	const style = new StyleSpecificationComposer({
		sources: { moon: { type: "vector", url: "https://tiles.mailwoman.ai/moon.json" } },
		baseLayers: [{ id: "space", type: "background", paint: { "background-color": "#000" } }],
		hillshadeSource: null,
		sprite: null,
	}).toJSON()

	expect(style.layers.map((layer) => layer.id)).toEqual(["space"])
	expect(Object.keys(style.sources)).toEqual(["moon"])
	expect("sprite" in style).toBe(false)
	expect(style.glyphs).toMatch(/protomaps\/fonts/u)
})

test("Composer: two instances from the shared BaseLayers have independent layer lists", () => {
	const a = new StyleSpecificationComposer({ sources: {} })
	const baseCount = a.layers.length
	const b = new StyleSpecificationComposer({ sources: {} })
	expect(b.layers).toHaveLength(baseCount)
	expect(a.layers).toHaveLength(baseCount)
})
