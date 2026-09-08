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

		const labels = style.layers.find((layer) => layer.id === "planetary/nomenclature-labels")
		expect(labels?.type).toBe("symbol")

		const space = style.layers.find((layer) => layer.id === "planetary/space")
		expect(space).toMatchObject({ type: "background", paint: { "background-color": PALETTES[body].space } })
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
