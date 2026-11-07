/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import type { NADRecord } from "#us/adapters/usgov/nad/adapter"
import { nadAddressNames, nadAddressRecord } from "#us/address-records/nad"

/**
 * Release 24's row for 390 White Horse Court in the Town of Rome, Adams County, Wisconsin.
 */
const WHITE_HORSE: NADRecord = {
	OID_: "34538810",
	UUID: "0002173c-ada8-4421-acf2-f9b6f12b52f0",
	Add_Number: "390",
	AddNo_Full: "390",
	St_Name: "White Horse",
	St_PosTyp: "Court",
	StNam_Full: "White Horse Court",
	County: "Adams",
	Inc_Muni: "Town of Rome",
	Post_City: "Not stated",
	State: "WI",
	Zip_Code: "54457",
	AddAuth: "co.adams.wi.us",
	Longitude: "-89.79717332487128",
	Latitude: "44.19990448088563",
	Placement: "Unknown",
}

describe("NAD address records", () => {
	it("states the written and bare municipality as localities and skips a placeholder postal city", () => {
		const names = nadAddressNames(WHITE_HORSE)

		expect(names.map(({ level, form, value }) => `${level}:${form}:${value}`)).toEqual([
			"region:written:WI",
			"subregion:written:Adams",
			"locality:written:Town of Rome",
			"locality:bare:Rome",
		])
	})

	it("keeps a postal city that differs from the municipality, and a pair of level and key once", () => {
		const names = nadAddressNames({ ...WHITE_HORSE, Inc_Muni: "CITY OF WAUWATOSA", Post_City: "Wauwatosa" })

		expect(names.filter((name) => name.level === "locality").map((name) => name.value)).toEqual([
			"CITY OF WAUWATOSA",
			"WAUWATOSA",
		])
	})

	it("emits a record without a ZIP Code, with its position, authority and publisher id", () => {
		const record = nadAddressRecord({ ...WHITE_HORSE, Zip_Code: null })

		expect(record).toMatchObject({
			source: "usgov-nad",
			sourceRecordID: "0002173c-ada8-4421-acf2-f9b6f12b52f0",
			country: "US",
			number: "390",
			streetRaw: "White Horse Court",
			postcode: null,
			lat: 44.19990448088563,
			lon: -89.79717332487128,
			authority: "co.adams.wi.us",
			placement: "Unknown",
		})
	})

	it("reads a territory row's country from its own ISO code", () => {
		expect(nadAddressRecord({ ...WHITE_HORSE, State: "PR" })?.country).toBe("PR")
	})

	it("falls back to the object id under the placeholder UUID, and refuses a row without a position", () => {
		const placeholder = nadAddressRecord({ ...WHITE_HORSE, UUID: "00000000-0000-0000-0000-000000000000" })

		expect(placeholder?.sourceRecordID).toBe("oid:34538810")
		expect(nadAddressRecord({ ...WHITE_HORSE, Latitude: null })).toBeNull()
	})
})
