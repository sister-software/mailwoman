// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { isPresent } from "@mailwoman/core/objects"
import { workspacePath } from "@mailwoman/core/paths"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import type { NADRecord } from "#us/adapters/usgov/nad/adapter"
import { nadAddressNames, nadAddressRecord } from "#us/address-records/nad"

const CORPUS_FIXTURE = workspacePath("corpus", "lib", "us", "adapters", "usgov", "nad", "fixtures", "fixture.ndjson")

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

	it("keeps a unit part once when the publisher writes it into two columns, and joins distinct parts", () => {
		// Release 24's row for 43 Belanger Drive, Lake Luzerne NY 12846, states `Apartment 2` as both Building and Unit.
		expect(nadAddressRecord({ ...WHITE_HORSE, Building: "Apartment 2", Unit: "Apartment 2" })?.unit).toBe("Apartment 2")
		expect(nadAddressRecord({ ...WHITE_HORSE, Building: "Building C", Unit: "Unit 4" })?.unit).toBe("Building C Unit 4")
	})

	it("reads a territory row's country from its own ISO code, and a state row's subdivision from its USPS code", () => {
		expect(nadAddressRecord({ ...WHITE_HORSE, State: "PR" })).toMatchObject({ country: "PR", subdivision: null })
		expect(nadAddressRecord(WHITE_HORSE)?.subdivision).toBe("US-WI")
	})

	it("emits a record for each of the corpus fixture's rows that states a number, a street and a state", async () => {
		const fixture = await Array.fromAsync(JSONSpliterator.fromAsync<Record<string, unknown>>(CORPUS_FIXTURE))

		// The corpus fixture predates positions, so each row is given one.
		// Its strings stay as the release writes them.
		const rows = fixture.map((row): NADRecord => ({
			...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? null : String(value)])),
			Longitude: "-89.4",
			Latitude: "43.07",
		}))

		const records = rows.map(nadAddressRecord)

		// Row 4 (Yellowstone) has no house number and row 11 the state `ZZ`, so 10 of the 12 rows emit.
		// Rows without a postal city or a ZIP Code still place a point.
		expect(records.filter(isPresent)).toHaveLength(10)
		expect(records[3]).toBeNull()
		expect(records[10]).toBeNull()
		expect(records[6]?.country).toBe("PR")
		expect(records[7]?.number).toBe("99 b")
		expect(records[11]?.postcode).toBeNull()
	})

	it("falls back to the object id under the placeholder UUID, and refuses a row without a position", () => {
		const placeholder = nadAddressRecord({ ...WHITE_HORSE, UUID: "00000000-0000-0000-0000-000000000000" })

		expect(placeholder?.sourceRecordID).toBe("oid:34538810")
		expect(nadAddressRecord({ ...WHITE_HORSE, Latitude: null })).toBeNull()
	})
})
