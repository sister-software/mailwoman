// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { type Feature, featureFilter, type FilterSpecification } from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, test } from "vitest"

import { BaseLayers } from "#base/layers"
import { UnderseaLabelLayers } from "#base/undersea"
import { CoverageLayers } from "#coverage"
import { gazetteerOverlayLayers, gazetteerPostcodeLayers } from "#gazetteer-overlay"
import { JurisdictionLayers } from "#jurisdictions"
import { LAYER_TOGGLE_GROUPS, resolveLayerToggle } from "#layer-toggles"

/**
 * The layers Earth adds outside the composed style: the graticule and the two building scenes.
 */
const RUNTIME_LAYER_IDS = ["mw-graticule-line", "compact-buildings", "city-models"]

/**
 * Every source layer `hrt overlay` writes, across the place and postcode tile sets.
 */
const OVERLAY_SOURCE_LAYERS = new Set(["boundaries", "points", "extents", "postcode_boundaries", "postcode_points"])

/**
 * The overlay switches paired with a basemap place layer, with that layer.
 */
const PAIRED_LABELS = [
	["countries", "places_country"],
	["regions", "places_region"],
	["localities", "places_locality"],
	["neighborhoods", "places_subplace"],
] as const

const overlay = gazetteerOverlayLayers("page-overlay", OVERLAY_SOURCE_LAYERS, BaseLayers)
const postcodes = gazetteerPostcodeLayers("page-overlay-postcodes", OVERLAY_SOURCE_LAYERS)

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

			if (resolveLayerToggle(layer) === "canvas") return []

			const matches = LAYER_TOGGLE_GROUPS.flatMap((group) => group.toggles).filter((toggle) => toggle.match?.test(leaf))

			return matches.length === 1 ? [] : [`${layer.id}: ${matches.map((toggle) => toggle.key).join(", ") || "none"}`]
		})

		expect(ambiguous).toEqual([])
	})

	test("overlay labels stack in the basemap's order, so larger places are placed first", () => {
		const stackOf = (layers: readonly { id: string }[], ids: readonly string[]) =>
			ids.map((id) => layers.findIndex((layer) => layer.id === id))

		const basemap = stackOf(
			BaseLayers,
			PAIRED_LABELS.map(([, basemapLayer]) => basemapLayer)
		)

		const copies = stackOf(
			overlay,
			PAIRED_LABELS.map(([key]) => `page-overlay-${key}-labels`)
		)

		const rankOf = (positions: number[]) =>
			positions.map((position) => positions.toSorted((a, b) => a - b).indexOf(position))

		expect(copies).not.toContain(-1)
		expect(rankOf(copies)).toEqual(rankOf(basemap))
	})

	test("each Who's On First record draws under one switch: by placetype when candidate.db takes it, by status when not", () => {
		const evaluate = (filter: FilterSpecification, properties: Feature["properties"]) => {
			const { filter: matches } = featureFilter(filter, "filter")
			const feature: Feature = { type: "Point", properties }

			return matches({ zoom: 10 }, feature)
		}

		const records = [
			{ placetype: "locality", is_current: true, is_deprecated: false, is_superseded: false },
			{ placetype: "locality", is_deprecated: false, is_superseded: false },
			{ placetype: "locality", is_current: false, is_deprecated: false, is_superseded: false },
			{ placetype: "locality", is_current: true, is_deprecated: false, is_superseded: true },
			{ placetype: "locality", is_current: false, is_deprecated: true, is_superseded: false },
			{ placetype: "county", is_current: true, is_deprecated: false, is_superseded: false, is_ceased: true },
		]

		const labels = overlay.filter((layer) => layer.type === "symbol")

		const matches = records.map((properties) =>
			labels
				.filter((layer) => "filter" in layer && layer.filter != null && evaluate(layer.filter, properties))
				.map((layer) => layer.id)
				.join(",")
		)

		expect(matches).toEqual([
			"page-overlay-localities-labels",
			"page-overlay-localities-labels",
			"page-overlay-former-labels",
			"page-overlay-localities-labels",
			"page-overlay-deprecated-labels",
			"page-overlay-counties-labels",
		])
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
