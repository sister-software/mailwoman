/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createPlanetaryStyle, PALETTES } from "@mailwoman/cartographer/planetary"
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec"
import { expect, test } from "vitest"

test.each(["moon", "mars"] as const)(
	"%s: a valid style with no Earth layer, no sprite, labels decluttered by diameter",
	(body) => {
		const style = createPlanetaryStyle({
			body,
			nomenclatureTileJSONURL: `https://tiles.mailwoman.ai/${body}.json`,
			hillshadeTileJSONURL: `https://tiles.mailwoman.ai/${body}-hillshade.json`,
		})

		expect(validateStyleMin(style)).toEqual([])

		expect(style.layers.map((layer) => layer.id)).toEqual([
			"planetary/space",
			"planetary/hillshade",
			"planetary/nomenclature-labels",
			"planetary/selection",
		])

		expect(Object.keys(style.sources)).toEqual(["nomenclature", "hillshade"])
		expect("sprite" in style).toBe(false)
		expect(style.glyphs).toMatch(/protomaps\/fonts/u)

		// MapLibre 6 reads the projection from the style; as a map option it is ignored and the body renders flat.
		expect(style.projection).toEqual({ type: "globe" })

		const labels = style.layers.find((layer) => layer.id === "planetary/nomenclature-labels")
		expect(labels?.type).toBe("symbol")

		// The archive carries terrarium-encoded elevation, so the relief is shaded at draw time and every body-specific
		// colour lives here. A greyscale image could not be tinted at all.
		expect(style.sources["hillshade"]).toMatchObject({ type: "raster-dem", encoding: "terrarium" })

		const relief = style.layers.find((layer) => layer.id === "planetary/hillshade")

		expect(relief).toMatchObject({
			type: "hillshade",
			paint: {
				"hillshade-highlight-color": PALETTES[body].reliefHighlight,
				"hillshade-shadow-color": PALETTES[body].reliefShadow,
			},
		})

		// Under globe projection a background layer paints the SPHERE, so this is the body's surface tone rather than
		// the field around it; the app's stylesheet paints that behind a transparent canvas.
		const surface = style.layers.find((layer) => layer.id === "planetary/space")
		expect(surface).toMatchObject({ type: "background", paint: { "background-color": PALETTES[body].space } })

		// The two bodies must not render alike, which is what a shared grey ramp made them do.
		expect(PALETTES.moon.reliefHighlight).not.toEqual(PALETTES.mars.reliefHighlight)
	}
)

test("without a hillshade tileset the style carries neither the source nor the layer", () => {
	const style = createPlanetaryStyle({
		body: "moon",
		nomenclatureTileJSONURL: "https://tiles.mailwoman.ai/moon.json",
	})

	expect(validateStyleMin(style)).toEqual([])
	expect(Object.keys(style.sources)).toEqual(["nomenclature"])

	expect(style.layers.map((layer) => layer.id)).toEqual([
		"planetary/space",
		"planetary/nomenclature-labels",
		"planetary/selection",
	])
})
