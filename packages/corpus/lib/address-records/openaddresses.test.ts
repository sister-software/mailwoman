/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { describe, expect, it } from "vitest"

import { createUnitSplitter } from "#adapters/street/unit"
import {
	openAddressesAddressRecord,
	openAddressesRunCountry,
	openAddressesRunSubdivision,
	readOpenAddressesRunRecords,
} from "#address-records/openaddresses"
import { useScratchDir } from "#test-kit"

const scratch = useScratchDir("address-records-openaddresses")

/**
 * Ten rows in an OpenAddresses run's own column order, with three the adapter refuses:
 * one without a number, one without a street and one without a position.
 */
const RUN_CSV = [
	"LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH",
	"-89.4012,43.0731,100,N Hamilton St,,City of Madison,Dane,WI,53703,,a1b2c3d4e5f60718",
	"-89.4100,43.0700,22,E Mifflin St,Apt 4,Madison,Dane,WI,53703-2105,,b1b2c3d4e5f60718",
	"-88.0070,43.0490,7720,Harwood Ave,,CITY OF WAUWATOSA,Milwaukee,WI,,,c1b2c3d4e5f60718",
	'-87.9065,43.0389,1,"Main St, Rear",,Milwaukee,Milwaukee,WI,53202,P-17,',
	"-88.1000,43.1000,,Bluemound Rd,,Brookfield,Waukesha,WI,53005,,e1b2c3d4e5f60718",
	"-88.1000,43.1000,15,,,Brookfield,Waukesha,WI,53005,,f1b2c3d4e5f60718",
	",,15,Capitol Dr,,Pewaukee,Waukesha,WI,53072,,a2b2c3d4e5f60718",
	"-89.5000,44.5000,4500,County Road X,,Town of Plover,Portage,WI,54467,,a3b2c3d4e5f60718",
	"-89.6000,44.6000,12-14,Elm St,,Stevens Point,Portage,WI,54481,,a4b2c3d4e5f60718",
	"-89.7000,44.7000,9,Oak Ln,,,,WI,,,",
	"",
].join("\n")

describe("OpenAddresses address records", () => {
	it("reads the country from the run's member path", () => {
		expect(openAddressesRunCountry("us/wi/statewide")).toBe("US")
		expect(openAddressesRunCountry("de/berlin")).toBe("DE")
		expect(openAddressesRunSubdivision("us/wi/statewide")).toBe("US-WI")
		expect(openAddressesRunSubdivision("de/berlin")).toBeNull()
		expect(() => openAddressesRunCountry("statewide")).toThrow(/country code/)
	})

	it("emits seven of ten run rows and keeps the member as the wire source id", async () => {
		const csv = scratch.path("statewide.csv")

		await writeLocalTextFile(RUN_CSV, csv)

		const records = await Array.fromAsync(readOpenAddressesRunRecords(csv, "us/wi/statewide", "us"))

		expect(records).toHaveLength(7)
		expect(new Set(records.map((record) => record.source))).toEqual(new Set(["openaddresses:us/wi/statewide"]))
		expect(records.every((record) => record.country === "US" && record.subdivision === "US-WI")).toBe(true)

		const quoted = records.find((record) => record.number === "1")

		expect(quoted?.streetRaw).toBe("Main St, Rear")
		expect(quoted?.sourceRecordID).toBe("P-17")
	})

	it("states the written city with its bare form, the district as the subregion, and a missing ZIP as null", () => {
		const record = openAddressesAddressRecord(
			{
				lon: "-88.0070",
				lat: "43.0490",
				number: "7720",
				street: "Harwood Ave",
				city: "CITY OF WAUWATOSA",
				district: "Milwaukee",
				region: "WI",
				hash: "c1b2c3d4e5f60718",
			},
			"us/wi/statewide",
			"us"
		)

		expect(record?.postcode).toBeNull()
		expect(record?.sourceRecordID).toBe("c1b2c3d4e5f60718")

		expect(record?.names.map(({ level, form, value }) => `${level}:${form}:${value}`)).toEqual([
			"region:written:WI",
			"subregion:written:Milwaukee",
			"locality:written:CITY OF WAUWATOSA",
			"locality:bare:WAUWATOSA",
		])
	})

	it("derives no bare form outside a country with legal-form words, and digests a row without an id", () => {
		const record = openAddressesAddressRecord(
			{ lon: "13.4050", lat: "52.5200", number: "1", street: "Unter den Linden", city: "Berlin" },
			"de/berlin",
			"de"
		)

		expect(record?.names.map((name) => name.form)).toEqual(["written"])
		expect(record?.streetKey).toBe(normalizeStreetForKeyLocale("Unter den Linden", "de"))
		expect(record?.sourceRecordID).toMatch(/^digest:[0-9a-f]{12}$/u)
	})

	it("splits a unit written at the end of the street when the run's unit column is empty", async () => {
		const units = await createUnitSplitter()
		const base = { lon: "-121.28801", lat: "38.74546", number: "100", postcode: "95678" }

		// Placer County's run writes `VERNON ST APT 114` with an empty UNIT column.
		const split = openAddressesAddressRecord({ ...base, street: "VERNON ST APT 114" }, "us/ca/placer", "us", units)

		expect(split?.streetRaw).toBe("VERNON ST")
		expect(split?.unit).toBe("APT 114")
		expect(split?.streetKey).toBe(normalizeStreetForKeyLocale("VERNON ST", "us"))

		// A stated unit is kept, and its street is left as written.
		const stated = openAddressesAddressRecord(
			{ ...base, street: "VERNON ST APT 114", unit: "114" },
			"us/ca/placer",
			"us",
			units
		)

		expect(stated?.streetRaw).toBe("VERNON ST APT 114")
		expect(stated?.unit).toBe("114")
		// Without a splitter the street is kept as written.
		expect(openAddressesAddressRecord({ ...base, street: "VERNON ST APT 114" }, "us/ca/placer", "us")?.unit).toBeNull()
	})
})
