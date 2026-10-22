/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	electedPlateauTilesets,
	PLATEAU_SITE_POLICY_LICENSE,
	plateauTilesetsInView,
	type PlateauTileset,
} from "#jp/plateau"

import plateauTilesets from "../../data/plateau-tilesets.json" with { type: "json" }

const CHIYODA: PlateauTileset = {
	cityCode: "13101",
	city: "千代田区",
	prefecture: "東京都",
	year: 2025,
	dataset: "plateau-13101-chiyoda-ku-2025",
	licenseTitle: PLATEAU_SITE_POLICY_LICENSE,
	url: "https://example.test/13101/tileset.json",
	bounds: [139.73, 35.66, 139.79, 35.71],
}

describe("electedPlateauTilesets", () => {
	it("keeps only the tilesets whose CKAN record states the site policy", () => {
		const unmatched = { ...CHIYODA, cityCode: "25204", licenseTitle: null }

		expect(electedPlateauTilesets([CHIYODA, unmatched])).toEqual([CHIYODA])
	})

	it("finds Tokyo Station's ward among the committed tilesets", () => {
		const elected = electedPlateauTilesets(plateauTilesets as PlateauTileset[])

		expect(plateauTilesetsInView(elected, [139.766, 35.681, 139.767, 35.682]).map((t) => t.cityCode)).toContain("13101")
	})
})

describe("plateauTilesetsInView", () => {
	it("selects a tileset that overlaps the view and skips one that does not", () => {
		expect(plateauTilesetsInView([CHIYODA], [139.76, 35.67, 139.77, 35.69])).toEqual([CHIYODA])
		expect(plateauTilesetsInView([CHIYODA], [135.4, 34.6, 135.6, 34.7])).toEqual([])
	})
})
