/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, test } from "vitest"

import {
	addressSystemColor,
	createJurisdictionSource,
	JurisdictionLayerID,
	JurisdictionLayers,
	JurisdictionLegends,
	JurisdictionTileSetID,
} from "#jurisdictions"

describe("the jurisdiction layers", () => {
	test("validate as a MapLibre style, expressions included", () => {
		const style = {
			version: 8 as const,
			sources: {
				[JurisdictionTileSetID]: createJurisdictionSource("https://tiles.mailwoman.ai/jurisdictions-v1.json"),
			},
			layers: JurisdictionLayers,
		}

		expect(validateStyleMin(style)).toEqual([])
	})

	test("give every fill a legend", () => {
		const fills = JurisdictionLayers.filter((layer) => layer.type === "fill").map((layer) => layer.id)

		expect(fills.toSorted()).toEqual(Object.keys(JurisdictionLegends).toSorted())
		expect(fills).not.toContain(JurisdictionLayerID.outline)
	})

	test("color neighboring address-system ids differently", () => {
		const colors = Array.from({ length: 39 }, (_, id) => addressSystemColor(id))

		expect(new Set(colors).size).toBe(39)
		expect(addressSystemColor(1)).not.toBe(addressSystemColor(2))
	})
})
