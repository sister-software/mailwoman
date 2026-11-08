/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	airportRecordCount,
	airportRecordsHeader,
	airportsInCountry,
	fillCountryAirports,
	getAirportByIATA,
} from "#iata/airports/records"
import { isAirportCode, parseAirportCode } from "#iata/airports/validate"

interface Airports {
	records: Array<{
		iata: string
		icao: string | null
		name: string
		country: string | null
		countryStatus: string
		latitude: number
		longitude: number
		facility: string
	}>
}

const normalized = await readLocalJSONFile<Airports>(
	workspacePath("registry", "data", "normalized", "iata-airports.json")
)

describe("IATA airport records", () => {
	it("read back every normalized record by its code", () => {
		expect(airportRecordCount()).toBe(normalized.records.length)

		for (const record of normalized.records) {
			const read = getAirportByIATA(record.iata)

			expect(read).toMatchObject({
				iata: record.iata,
				icao: record.icao,
				name: record.name,
				country: record.country,
				countryStatus: record.countryStatus,
				facility: record.facility,
			})

			expect(read!.latitude).toBe(record.latitude)
			expect(read!.longitude).toBe(record.longitude)
			expect(isAirportCode(record.iata)).toBe(true)
		}
	})

	it("relates airports to the country the source places them in", () => {
		const australia = airportsInCountry("AU")

		const expected = normalized.records.filter(
			(record) => record.country === "AU" && record.countryStatus === "iso3166-1"
		)

		expect(australia.map((record) => record.iata).toSorted()).toEqual(expected.map((record) => record.iata).toSorted())

		const rows = new Uint32Array(expected.length)

		expect(fillCountryAirports("AU", rows)).toBe(expected.length)
		expect(fillCountryAirports("AU", new Uint32Array(1))).toBe(-1)
	})

	it("places an extension-country airport in no country's list", () => {
		const extension = normalized.records.find((record) => record.countryStatus === "source-extension")

		if (!extension) return

		expect(getAirportByIATA(extension.iata)?.country).toBe(extension.country)
		expect(airportsInCountry(extension.country!)).toEqual([])
	})

	it("refuses a metropolitan code the open profile does not hold, and says so", () => {
		expect(airportRecordsHeader().kinds).toEqual(["airport"])
		expect(parseAirportCode("aus")).toMatchObject({ ok: false, reason: "case" })
		expect(parseAirportCode("AUSS")).toMatchObject({ ok: false, reason: "shape" })
	})
})
