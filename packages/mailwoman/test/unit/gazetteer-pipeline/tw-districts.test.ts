/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pure half of `gazetteer build tw-districts`: the 縣市 → WOF region match and the 臺/台 name twins. The
 *   region rows below are the admin artifact's own Han names for the four regions whose names collide or drifted.
 */

import {
	districtNameVariants,
	matchTaiwanRegion,
	type TaiwanRegionName,
} from "mailwoman/gazetteer-pipeline/tw-districts"
import { describe, expect, test } from "vitest"

const HSINCHU_CITY = 85_679_557
const HSINCHU_COUNTY = 85_679_563
const TAOYUAN = 85_679_589
const TAIPEI = 85_679_583
const TAICHUNG = 85_679_617

/**
 * As `names` has them: Hsinchu County lists 新竹市 as a variant beside its official 新竹縣; Taoyuan's official name is still
 * the pre-upgrade 桃園 with 桃園縣 beside it; Taipei's official spelling is 台北市 with 臺北市 as a variant.
 */
const REGIONS: TaiwanRegionName[] = [
	{ id: HSINCHU_CITY, name: "新竹市", official: true },
	{ id: HSINCHU_CITY, name: "新竹", official: false },
	{ id: HSINCHU_COUNTY, name: "新竹縣", official: true },
	{ id: HSINCHU_COUNTY, name: "新竹市", official: false },
	{ id: HSINCHU_COUNTY, name: "新竹", official: false },
	{ id: TAOYUAN, name: "桃園", official: true },
	{ id: TAOYUAN, name: "桃園縣", official: false },
	{ id: TAIPEI, name: "台北市", official: true },
	{ id: TAIPEI, name: "臺北市", official: false },
	{ id: TAICHUNG, name: "臺中市", official: true },
	{ id: TAICHUNG, name: "台中市", official: false },
]

describe("matchTaiwanRegion", () => {
	test("the official name wins over a county that lists the city's name as a variant", () => {
		expect(matchTaiwanRegion("新竹市", REGIONS)).toBe(HSINCHU_CITY)
		expect(matchTaiwanRegion("新竹縣", REGIONS)).toBe(HSINCHU_COUNTY)
	})

	test("a register 縣市 WOF still names by its pre-upgrade form matches through the suffix-stripped stem", () => {
		expect(matchTaiwanRegion("桃園市", REGIONS)).toBe(TAOYUAN)
	})

	test("臺 and 台 spellings meet on either side", () => {
		expect(matchTaiwanRegion("臺北市", REGIONS)).toBe(TAIPEI)
		expect(matchTaiwanRegion("台中市", REGIONS)).toBe(TAICHUNG)
	})

	test("a 縣市 no region answers to is an absence, not a guess", () => {
		expect(matchTaiwanRegion("宜蘭縣", REGIONS)).toBeUndefined()
		// The stem `新竹` names two regions, so it answers nothing.
		expect(matchTaiwanRegion("新竹", REGIONS)).toBeUndefined()
	})
})

describe("districtNameVariants", () => {
	test("a name with 臺 or 台 yields the register spelling first and its twin second", () => {
		expect(districtNameVariants("霧臺鄉")).toEqual(["霧臺鄉", "霧台鄉"])
		expect(districtNameVariants("台西鄉")).toEqual(["台西鄉", "臺西鄉"])
	})

	test("a name carrying neither character yields itself alone", () => {
		expect(districtNameVariants("林口區")).toEqual(["林口區"])
	})
})
