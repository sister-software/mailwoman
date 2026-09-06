/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The compound-municipality split: city + ward and county + town, and the plain values it leaves alone.
 */

import { compoundMunicipality } from "@mailwoman/resolver/admin"
import { describe, expect, it } from "vitest"

describe("compoundMunicipality", () => {
	it("splits a city and its ward at the first 市", () => {
		expect(compoundMunicipality("神戸市西区")).toEqual({ head: "神戸市", tail: "西区", shape: "city_ward" })
		expect(compoundMunicipality("北九州市門司区")).toEqual({ head: "北九州市", tail: "門司区", shape: "city_ward" })
		expect(compoundMunicipality("大阪市北区")).toEqual({ head: "大阪市", tail: "北区", shape: "city_ward" })
	})

	it("splits a county and its town or village", () => {
		expect(compoundMunicipality("猿島郡五霞町")).toEqual({ head: "猿島郡", tail: "五霞町", shape: "county_town" })
		expect(compoundMunicipality("大島郡知名町")).toEqual({ head: "大島郡", tail: "知名町", shape: "county_town" })

		expect(compoundMunicipality("南都留郡山中湖村")).toEqual({
			head: "南都留郡",
			tail: "山中湖村",
			shape: "county_town",
		})
	})

	it("leaves a plain municipality alone, a 村 or 区 inside the name included", () => {
		for (const plain of ["都城市", "千代田区", "東村山市", "かすみがうら市", "区", ""]) {
			expect(compoundMunicipality(plain)).toBeNull()
		}
	})
})
