/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { boundsFromTilesetHead, datasetNameFromTilesetURL } from "#sdk/plateau"

describe("datasetNameFromTilesetURL", () => {
	it("builds the CKAN name from a prefecture or city release URL", () => {
		expect(
			datasetNameFromTilesetURL(
				"https://assets.cms.plateau.reearth.io/assets/72/x/13101_chiyoda-ku_pref_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod2_no_texture/tileset.json"
			)
		).toBe("plateau-13101-chiyoda-ku-2025")

		expect(
			datasetNameFromTilesetURL(
				"https://assets.cms.plateau.reearth.io/assets/c7/x/47201_naha-shi_city_2020_citygml_7_op_bldg_3dtiles_lod2_no_texture/tileset.json"
			)
		).toBe("plateau-47201-naha-shi-2020")
	})
})

describe("boundsFromTilesetHead", () => {
	it("converts the root region from radians to degrees", () => {
		const head =
			'{"root":{"boundingVolume":{"region":[2.4387514680776667,0.6225417170957137,2.439669520160431,0.6231729322194112,35.3,252.1]}'

		const [west, south, east, north] = boundsFromTilesetHead(head)!

		expect(west).toBeCloseTo(139.73, 2)
		expect(south).toBeCloseTo(35.669, 2)
		expect(east).toBeCloseTo(139.78, 2)
		expect(north).toBeCloseTo(35.705, 2)
	})

	it("returns null for a head without a region", () => {
		expect(boundsFromTilesetHead('{"root":{"boundingVolume":{"box":[0,0,0]}}}')).toBeNull()
	})
})
