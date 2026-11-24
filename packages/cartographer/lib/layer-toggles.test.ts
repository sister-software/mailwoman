// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { BaseLayers } from "#base/layers"
import { UnderseaLabelLayers } from "#base/undersea"
import { CoverageLayers } from "#coverage"
import { GazetteerOverlaySourceLayer, gazetteerOverlayLayers, gazetteerPostcodeLayers } from "#gazetteer-overlay"
import { JurisdictionLayers } from "#jurisdictions"
import { BASE_CANVAS_LAYER, LAYER_TOGGLE_GROUPS, resolveLayerToggle } from "#layer-toggles"

/**
 * The layers Earth adds outside the composed style: the graticule and the two building scenes.
 */
const RUNTIME_LAYER_IDS = ["mw-graticule-line", "compact-buildings", "city-models"]

const overlay = gazetteerOverlayLayers("page-overlay", new Set(Object.values(GazetteerOverlaySourceLayer)), BaseLayers)
const postcodes = gazetteerPostcodeLayers("page-overlay-postcodes", new Set(Object.values(GazetteerOverlaySourceLayer)))

const styleLayers = [
	...BaseLayers,
	...UnderseaLabelLayers,
	...CoverageLayers,
	...JurisdictionLayers,
	...RUNTIME_LAYER_IDS.map((id) => ({ id })),
]

describe("layer toggles", () => {
	test("every layer Earth draws has a switch or is a canvas fill", () => {
		const unplaced = [...styleLayers, ...overlay, ...postcodes]
			.filter((layer) => resolveLayerToggle(layer) === null)
			.map((layer) => layer.id)

		expect(unplaced).toEqual([])
	})

	test("each basemap layer matches exactly one switch pattern", () => {
		const ambiguous = styleLayers.flatMap((layer) => {
			const leaf = layer.id.slice(layer.id.lastIndexOf("/") + 1)

			if (BASE_CANVAS_LAYER.test(leaf)) return []

			const matches = LAYER_TOGGLE_GROUPS.flatMap((group) => group.toggles).filter((toggle) => toggle.match?.test(leaf))

			return matches.length === 1 ? [] : [`${layer.id}: ${matches.map((toggle) => toggle.key).join(", ") || "none"}`]
		})

		expect(ambiguous).toEqual([])
	})

	test("each overlay label copies the basemap layer it replaces", () => {
		const localities = overlay.find((layer) => layer.id === "page-overlay-localities-labels")
		const basemap = BaseLayers.find((layer) => layer.id === "places_locality")

		expect(localities?.type).toBe("symbol")
		expect(basemap?.type).toBe("symbol")

		if (localities?.type !== "symbol" || basemap?.type !== "symbol") return

		// The copy reads a missing field through `["coalesce", read, fallback]`;
		// without those wrappers it is the basemap's.
		const unwrap = (value: unknown): unknown =>
			Array.isArray(value)
				? value[0] === "coalesce" && Array.isArray(value[1]) && value[1][0] === "get"
					? value[1]
					: value.map(unwrap)
				: value

		expect(unwrap(localities.layout?.["text-size"])).toEqual(basemap.layout?.["text-size"])
		expect(unwrap(localities.layout?.["text-font"])).toEqual(basemap.layout?.["text-font"])
	})
})
