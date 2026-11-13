// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { getPOICategory } from "@mailwoman/poi-taxonomy/lookup"
import { describe, expect, it } from "vitest"

import { postOfficeCategoryID } from "#structures/source"
import { USGS_STRUCTURE_LAYERS, usgsStructureLayer } from "#us/structures/usgs-layers"

describe("USGS_STRUCTURE_LAYERS", () => {
	it("files every layer under a category the POI taxonomy holds", () => {
		const unknown = USGS_STRUCTURE_LAYERS.filter((layer) => !getPOICategory(layer.poiCategory))

		expect(unknown).toEqual([])
	})

	it("keys each layer by a distinct id in the Features group and a distinct slug", () => {
		const ids = USGS_STRUCTURE_LAYERS.map((layer) => layer.layerID)
		const slugs = USGS_STRUCTURE_LAYERS.map((layer) => layer.slug)

		expect(new Set(ids).size).toBe(ids.length)
		expect(new Set(slugs).size).toBe(slugs.length)
		// Layers 0–34 duplicate the Features layers as labels.
		expect(ids.every((id) => id >= 35)).toBe(true)
	})

	it("files the post-office layer under the category the post-office suite reads", () => {
		expect(usgsStructureLayer(38).poiCategory).toBe(postOfficeCategoryID())
	})

	it("refuses a layer the table doesn't list rather than guessing its category", () => {
		expect(() => usgsStructureLayer(69)).toThrow(/no layer 69/)
	})
})
