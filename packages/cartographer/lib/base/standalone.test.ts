// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { stringifyJSON } from "@mailwoman/core/json"
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, it } from "vitest"

import { BASEMAP_STYLE_NAMES, createBasemapStyle, isBasemapLanguage } from "#base/standalone"
import { MailwomanBaseTileSetID } from "#base/theme"
import { PROTOMAPS_GLYPHS_URL } from "#styles/assets"

const tileJSON = {
	tiles: ["https://tiles.mailwoman.post/planet.v4/{z}/{x}/{y}.mvt"],
	minzoom: 0,
	maxzoom: 15,
	bounds: [-180, -90, 180, 90] as [number, number, number, number],
	attribution: "© OpenStreetMap",
}

describe("createBasemapStyle", () => {
	it.each(BASEMAP_STYLE_NAMES)("builds a valid style for %s", (style) => {
		const spec = createBasemapStyle({ tileJSON, style })

		expect(validateStyleMin(spec)).toEqual([])
		expect(Object.keys(spec.sources)).toEqual([MailwomanBaseTileSetID])
		expect(spec.glyphs).toBe(PROTOMAPS_GLYPHS_URL)
		expect(spec.layers.length).toBeGreaterThan(50)
		expect(spec.layers.every((layer) => !("source" in layer) || layer.source === MailwomanBaseTileSetID)).toBe(true)
	})

	it("copies the TileJSON's tiles and zoom range into its one vector source", () => {
		const source = createBasemapStyle({ tileJSON }).sources[MailwomanBaseTileSetID]

		expect(source).toEqual({ type: "vector", ...tileJSON })
	})

	it("reads the sprite of the flavor a theme starts from", () => {
		expect(createBasemapStyle({ tileJSON, style: "dark" }).sprite).toMatch(/\/sprites\/v4\/dark$/)
		expect(createBasemapStyle({ tileJSON, style: "mailwoman" }).sprite).toMatch(/\/sprites\/v4\/light$/)
		expect(createBasemapStyle({ tileJSON, style: "mailwoman-dark" }).sprite).toMatch(/\/sprites\/v4\/dark$/)
	})

	it("labels in the requested language and refuses a malformed tag", () => {
		const labels = stringifyJSON(createBasemapStyle({ tileJSON, lang: "ja" }).layers)

		expect(labels).toContain("name:ja")
		expect(isBasemapLanguage("zh-Hans")).toBe(true)
		expect(isBasemapLanguage("en;drop")).toBe(false)
		expect(() => createBasemapStyle({ tileJSON, lang: "EN" })).toThrow(/invalid language tag/)
	})
})
