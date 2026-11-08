/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { compareCountryLists, normalizeAirports, normalizeCountries, splitQuotedCSVLine } from "#tools/normalize"

const binding = (item: string, label: string, alpha2: string, alpha3: string, numeric: string, dissolved?: string) => ({
	item: { type: "uri", value: `http://www.wikidata.org/entity/${item}` },
	itemLabel: { type: "literal", value: label },
	alpha2: { type: "literal", value: alpha2 },
	alpha3: { type: "literal", value: alpha3 },
	numeric: { type: "literal", value: numeric },
	...(dissolved ? { dissolved: { type: "literal", value: dissolved } } : {}),
})

describe("normalizeCountries", () => {
	it("records a dissolved state as formerly used and sorts by alpha-2", () => {
		const { records } = normalizeCountries(
			{
				results: {
					bindings: [
						binding("Q30", "United States", "US", "USA", "840"),
						binding("Q16957", "East Germany", "DD", "DDR", "278", "1990-10-03T00:00:00Z"),
					],
				},
			},
			"test"
		)

		expect(records.map((record) => record.alpha2)).toEqual(["DD", "US"])

		expect(records[0]).toMatchObject({
			status: "formerly-used",
			dissolved: "1990-10-03T00:00:00Z",
			entityID: "wikidata:Q16957",
		})

		expect(records[1]).toMatchObject({ status: "officially-assigned" })
		expect(records[1]).not.toHaveProperty("dissolved")
	})

	it("refuses a code outside the grammar rather than dropping the row", () => {
		expect(() =>
			normalizeCountries({ results: { bindings: [binding("Q1", "X", "us", "USA", "840")] } }, "test")
		).toThrow(/grammars/)
	})

	it("refuses two current entries on one code", () => {
		expect(() =>
			normalizeCountries(
				{ results: { bindings: [binding("Q1", "A", "US", "USA", "840"), binding("Q2", "B", "US", "USB", "841")] } },
				"test"
			)
		).toThrow(/held by/)
	})
})

describe("splitQuotedCSVLine", () => {
	it("reads quoted fields, escaped quotes and empty cells", () => {
		expect(splitQuotedCSVLine('"1","a ""b"" c","","x,y"')).toEqual(["1", 'a "b" c', "", "x,y"])
	})
})

const HEADER =
	'"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"'

const row = (
	id: string,
	type: string,
	name: string,
	lat: string,
	lon: string,
	country: string,
	iata: string,
	icao = ""
) =>
	`"${id}","${icao || id}","${type}","${name}","${lat}","${lon}","","NA","${country}","${country}-X","","yes","${icao}","${iata}","","","","",""`

describe("normalizeAirports", () => {
	const current = new Set(["US", "GB"])

	it("keeps rows with an IATA code, labels the country's status and sorts by code", () => {
		const csv = [
			HEADER,
			row("2", "large_airport", "Heathrow", "51.47", "-0.46", "GB", "LHR", "EGLL"),
			row("1", "heliport", "Pristina Heli", "42.6", "21.0", "XK", "PRX"),
			row("3", "small_airport", "No Code", "0", "0", "US", ""),
		].join("\n")

		const { records } = normalizeAirports(csv, current, "test")

		expect(records.map((record) => record.iata)).toEqual(["LHR", "PRX"])

		expect(records[0]).toMatchObject({
			icao: "EGLL",
			country: "GB",
			countryStatus: "iso3166-1",
			entityID: "ourairports:2",
			facility: "large_airport",
		})

		expect(records[1]).toMatchObject({ icao: null, country: "XK", countryStatus: "source-extension" })
	})

	it("refuses a duplicate code and an unreadable coordinate", () => {
		expect(() =>
			normalizeAirports(
				[
					HEADER,
					row("1", "heliport", "A", "1", "2", "US", "AAA"),
					row("2", "heliport", "B", "1", "2", "US", "AAA"),
				].join("\n"),
				current,
				"test"
			)
		).toThrow(/held by/)

		expect(() =>
			normalizeAirports([HEADER, row("1", "heliport", "A", "north", "2", "US", "AAA")].join("\n"), current, "test")
		).toThrow(/coordinate/)
	})
})

describe("compareCountryLists", () => {
	it("reports each side's extras without changing either", () => {
		const countries = [
			{
				entityID: "a",
				alpha2: "US",
				alpha3: "USA",
				numeric: "840",
				name: "US",
				status: "officially-assigned" as const,
			},
			{
				entityID: "b",
				alpha2: "AX",
				alpha3: "ALA",
				numeric: "248",
				name: "Åland",
				status: "officially-assigned" as const,
			},
		]

		const csv = '"id","code","name"\n"1","US","United States"\n"2","XK","Kosovo"'

		expect(compareCountryLists(countries, csv)).toEqual({ onlyOurAirports: ["XK"], onlyWikidata: ["AX"] })
	})
})
