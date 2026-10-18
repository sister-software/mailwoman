/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import {
	BSP_GU_ADAPTER_ID,
	BSP_GU_LICENSE,
	componentsForGuamRecord,
	createGuamAddressPointsAdapter,
	type GuamAddressPointRecord,
	guamHouseNumber,
	isGuamPlaceName,
} from "#gu/adapters/bsp/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("bsp-gu")

/**
 * Feature properties copied from `Address_Point_(Public_View)`, where an absent
 * string reads as a single space.
 */
const ROUTE_10 = {
	FID: 1,
	HOUSE_NUM: "452",
	PRE_DIR: " ",
	STREETNAME: "ROUTE 10",
	STR_TYPE: "HWY",
	FullRdNm: "ROUTE 10 HWY",
	UNIT: " ",
	CITY: "BARRIGADA",
	PLACENAME: "BARRIGADA",
}

const UNIT_C = {
	FID: 9,
	HOUSE_NUM: "350",
	PRE_DIR: " ",
	STREETNAME: "MARIA CANDELARIA",
	STR_TYPE: "ST",
	FullRdNm: "MARIA CANDELARIA ST",
	UNIT: "C",
	CITY: "ASAN",
	PLACENAME: "ASAN",
}

const HAGATNA = {
	FID: 29,
	HOUSE_NUM: "158",
	PRE_DIR: " ",
	STREETNAME: "BRADLEY",
	STR_TYPE: "LOOP",
	FullRdNm: "BRADLEY LOOP",
	UNIT: " ",
	CITY: "HAGÅTÑA",
	PLACENAME: "HAGÅTÑA",
}

const PERMIT = {
	FID: 191,
	HOUSE_NUM: "128 / B24-445",
	PRE_DIR: " ",
	STREETNAME: "SANTA ANA",
	STR_TYPE: "ST",
	FullRdNm: "SANTA ANA ST",
	UNIT: " ",
	CITY: "ASAN",
	PLACENAME: "ASAN",
}

const LETTER_UNIT = {
	FID: 206,
	HOUSE_NUM: "111 A",
	PRE_DIR: " ",
	STREETNAME: "CALLE DE LOS MARTERES",
	STR_TYPE: "ST",
	FullRdNm: "CALLE DE LOS MARTERES ST",
	UNIT: "A",
	CITY: "AGAT",
	PLACENAME: "AGAT",
}

const REPEATED_TYPE = {
	FID: 695,
	HOUSE_NUM: "556",
	PRE_DIR: " ",
	STREETNAME: "W ROUTE 8 HWY",
	STR_TYPE: "HWY",
	FullRdNm: "W ROUTE 8 HWY",
	UNIT: " ",
	CITY: "BARRIGADA",
	PLACENAME: "BARRIGADA",
}

const OFF_OF = {
	FID: 2579,
	HOUSE_NUM: "525A",
	PRE_DIR: " ",
	STREETNAME: "(OFF OF) CANADA TOTO LOOP ROAD",
	STR_TYPE: "RD",
	FullRdNm: "(OFF OF) CANADA TOTO LOOP RD.",
	UNIT: " ",
	CITY: "BARRIGADA",
	PLACENAME: "BARRIGADA",
}

const TWO_ROADS = {
	FID: 9644,
	HOUSE_NUM: "586",
	PRE_DIR: " ",
	STREETNAME: "E. MARINE CORPS DRIVE / ROUTE 1 HWY",
	STR_TYPE: " ",
	FullRdNm: "E. MARINE CORPS DRIVE ROUTE 1 HWY",
	UNIT: " ",
	CITY: "YIGO",
	PLACENAME: "YIGO",
}

const NO_STREET = {
	FID: 406,
	HOUSE_NUM: "140",
	PRE_DIR: " ",
	STREETNAME: " ",
	STR_TYPE: " ",
	FullRdNm: " ",
	UNIT: " ",
	CITY: "AGAT",
	PLACENAME: "AGAT",
}

const FULL_ROAD_NAME = {
	FID: 5384,
	HOUSE_NUM: "134",
	PRE_DIR: " ",
	STREETNAME: " ",
	STR_TYPE: " ",
	FullRdNm: "CHALAN BUNITA",
	UNIT: " ",
	CITY: "DEDEDO",
	PLACENAME: "DEDEDO",
}

const TYPO_CITY = {
	FID: 34_110,
	HOUSE_NUM: "150",
	PRE_DIR: " ",
	STREETNAME: "CEPEDA",
	STR_TYPE: "WAY",
	FullRdNm: "CEPEDA WAY",
	UNIT: " ",
	CITY: "BARRIGDAA",
	PLACENAME: " ",
}

const NOT_A_NUMBER = {
	FID: 11_700,
	HOUSE_NUM: "NOV",
	PRE_DIR: " ",
	STREETNAME: "KAYEN MENDIOLA STREET",
	STR_TYPE: " ",
	FullRdNm: "KAYEN MENDIOLA STREET",
	UNIT: " ",
	CITY: "YIGO",
	PLACENAME: "YIGO",
}

const PREFIXED = {
	FID: 5670,
	HOUSE_NUM: "126",
	PRE_DIR: "W",
	STREETNAME: "LIGUAN",
	STR_TYPE: "AVE",
	FullRdNm: "W LIGUAN AVE",
	UNIT: "B",
	CITY: "DEDEDO",
	PLACENAME: "DEDEDO",
}

const RECORDS = [
	ROUTE_10,
	UNIT_C,
	HAGATNA,
	PERMIT,
	LETTER_UNIT,
	REPEATED_TYPE,
	OFF_OF,
	TWO_ROADS,
	NO_STREET,
	FULL_ROAD_NAME,
	TYPO_CITY,
	NOT_A_NUMBER,
	PREFIXED,
] satisfies GuamAddressPointRecord[]

describe("componentsForGuamRecord", () => {
	it("reads a route road with its type, a unit, and a direction prefix", () => {
		expect(componentsForGuamRecord(ROUTE_10)).toEqual({
			house_number: "452",
			street: "ROUTE 10",
			street_suffix: "HWY",
			locality: "BARRIGADA",
		})

		expect(componentsForGuamRecord(UNIT_C)).toEqual({
			house_number: "350",
			street: "MARIA CANDELARIA",
			street_suffix: "ST",
			unit: "C",
			locality: "ASAN",
		})

		expect(componentsForGuamRecord(PREFIXED)).toEqual({
			house_number: "126",
			street_prefix: "W",
			street: "LIGUAN",
			street_suffix: "AVE",
			unit: "B",
			locality: "DEDEDO",
		})
	})

	it("keeps a house number beside a permit number and drops a type or unit the other columns repeat", () => {
		const dropped = new Map<string, number>()

		expect(componentsForGuamRecord(PERMIT, { dropped })?.house_number).toBe("128")

		expect(componentsForGuamRecord(LETTER_UNIT, { dropped })).toEqual({
			house_number: "111 A",
			street: "CALLE DE LOS MARTERES",
			street_suffix: "ST",
			locality: "AGAT",
		})

		expect(componentsForGuamRecord(REPEATED_TYPE, { dropped })).toEqual({
			house_number: "556",
			street: "W ROUTE 8 HWY",
			locality: "BARRIGADA",
		})

		expect(Object.fromEntries(dropped)).toEqual({
			"component:unit:repeats-house-number": 1,
			"component:street_suffix:repeats-street": 1,
		})
	})

	it("reads the assembled road name when STREETNAME is blank", () => {
		expect(componentsForGuamRecord(FULL_ROAD_NAME)).toEqual({
			house_number: "134",
			street: "CHALAN BUNITA",
			locality: "DEDEDO",
		})
	})

	it("refuses a road located off of, two roads, no street, no number and an unlisted place", () => {
		const dropped = new Map<string, number>()

		for (const record of [OFF_OF, TWO_ROADS, NO_STREET, NOT_A_NUMBER, TYPO_CITY]) {
			expect(componentsForGuamRecord(record, { dropped })).toBeNull()
		}

		expect(Object.fromEntries(dropped)).toEqual({
			"row:street-off-of": 1,
			"row:street-names-two-roads": 1,
			"row:no-street": 1,
			"row:house-number-not-a-number": 1,
			"component:locality:not-a-guam-place": 1,
			"row:no-locality": 1,
		})
	})
})

describe("isGuamPlaceName and guamHouseNumber", () => {
	it("accepts each spelling of a village and a village pair, and refuses a slip", () => {
		expect(
			["HAGÅTÑA", "Hagatna", "AGANA HEIGHTS (PAASAN)", "CHALAN PAGO - ORDOT", "MONGMONG- TOTO- MAITE"].every(
				isGuamPlaceName
			)
		).toBe(true)

		expect(["BARRIGDAA", "MANGIL.AO", "RADIO, BARRIGADA", ""].some(isGuamPlaceName)).toBe(false)
	})

	it("reads number shapes and refuses a permit alone or a range", () => {
		expect(["120", "231A", "155 A", "99-12"].map(guamHouseNumber)).toEqual(["120", "231A", "155 A", "99-12"])
		expect(guamHouseNumber("B19000483 / 133")).toBe("133")
		expect(guamHouseNumber("B19000483")).toBeNull()
		expect(guamHouseNumber("288A - 288")).toBeNull()
	})
})

describe("bsp-gu adapter", () => {
	it("reads a directory of query pages and stamps the label", async () => {
		const directory = scratch.path("pages")

		const page = (records: GuamAddressPointRecord[]) =>
			stringifyJSON({
				type: "FeatureCollection",
				features: records.map((properties, index) => ({
					type: "Feature",
					geometry: { type: "Point", coordinates: [144.8 + index / 1000, 13.46] },
					properties,
				})),
			})

		await writeLocalTextFile(page(RECORDS.slice(0, 6)), directory("page-000.geojson"))
		await writeLocalTextFile(page(RECORDS.slice(6)), directory("page-001.geojson"))

		const manifest = await runAdapter({
			adapter: createGuamAddressPointsAdapter(),
			adapterOptions: { inputPath: directory, country: "GU" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(8)

		const rows = await readCanonicalRows(scratch.path, BSP_GU_ADAPTER_ID)

		expect(rows.every((row) => row.license === BSP_GU_LICENSE && row.country === "GU")).toBe(true)
		expect(rows.map((row) => row.raw)).toContain("452 ROUTE 10 HWY, BARRIGADA")
		expect(rows.map((row) => row.raw)).toContain("126 W LIGUAN AVE B, DEDEDO")
		expect(rows.map((row) => row.raw)).toContain("158 BRADLEY LOOP, HAGÅTÑA")
	})

	it("refuses another country", async () => {
		const adapter = createGuamAddressPointsAdapter()

		await expect(
			adapter
				.rows({ inputPath: scratch.path("none"), country: "US" })
				[Symbol.asyncIterator]()
				.next()
		).rejects.toThrow(/bsp-gu/u)
	})
})
