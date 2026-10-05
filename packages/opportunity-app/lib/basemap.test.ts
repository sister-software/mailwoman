/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { MailwomanBaseTileSetID } from "@mailwoman/cartographer/base"
import { describe, expect, test } from "vitest"

import { basemapStyle, STUB_STYLE } from "#basemap"

describe("basemapStyle", () => {
	test("a build without a basemap URL draws the stub style, which names no source, glyph host or sprite", () => {
		const style = basemapStyle(null)

		expect(style).toBe(STUB_STYLE)
		expect(style.sources).toEqual({})
		expect(style.glyphs).toBeUndefined()
		expect(style.sprite).toBeUndefined()
		expect(style.layers.map((layer) => layer.type)).toEqual(["background"])
	})

	test("a build with a basemap URL draws the cartographer base style over that tileset", () => {
		const url = "https://tiles.example.test/basemap-v4.json"
		const style = basemapStyle(url)

		expect(style.sources[MailwomanBaseTileSetID]).toEqual({ type: "vector", url })
		expect(style.layers.length).toBeGreaterThan(1)
	})
})
