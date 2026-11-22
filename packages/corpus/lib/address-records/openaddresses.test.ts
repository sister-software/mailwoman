// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { gzip } from "@mailwoman/core/fs/compression"
import { writeLocalBuffer, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { normalizeStreetForKeyLocale, parseStreetLocale } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { CSVSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { createUnitSplitter } from "#adapters/street/unit"
import {
	openAddressesAddressRecord,
	openAddressesRunCountry,
	openAddressesRunSubdivision,
	openAddressesSourceCacheName,
	readOpenAddressesGeoJSONRunRecords,
	readOpenAddressesRunRecords,
} from "#address-records/openaddresses"
import { useScratchDir } from "#test-kit"

const scratch = useScratchDir("address-records-openaddresses")
const US = parseStreetLocale("us")
const DE = parseStreetLocale("de")

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

	it("reads a batch job's gzip-compressed GeoJSON into the same records as the run's CSV", async () => {
		const csv = scratch.path("statewide.csv")

		await writeLocalTextFile(RUN_CSV, csv)

		const rows = await Array.fromAsync(CSVSpliterator.fromAsync<Record<string, string>>(csv.toString()))

		const features = rows.map(({ LON, LAT, ...properties }) => ({
			type: "Feature",
			geometry: LON && LAT ? { type: "Point", coordinates: [Number(LON), Number(LAT)] } : null,
			properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value])),
		}))

		const geojson = scratch.path(openAddressesSourceCacheName("us/wi/statewide"))

		await writeLocalBuffer(await gzip(features.map((feature) => stringifyJSON(feature)).join("\n")), geojson)

		const fromCSV = await Array.fromAsync(readOpenAddressesRunRecords(csv, "us/wi/statewide", US))
		const fromGeoJSON = await Array.fromAsync(readOpenAddressesGeoJSONRunRecords(geojson, "us/wi/statewide", US))

		expect(geojson.toString()).toMatch(/us__wi__statewide\.source\.geojson\.gz$/)
		expect(fromGeoJSON).toHaveLength(7)
		expect(fromGeoJSON).toEqual(fromCSV)
	})

	it("emits seven of ten run rows and keeps the member as the wire source id", async () => {
		const csv = scratch.path("statewide.csv")

		await writeLocalTextFile(RUN_CSV, csv)

		const records = await Array.fromAsync(readOpenAddressesRunRecords(csv, "us/wi/statewide", US))

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
			US
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
			DE
		)

		expect(record?.names.map((name) => name.form)).toEqual(["written"])
		expect(record?.streetKey).toBe(normalizeStreetForKeyLocale("Unter den Linden", DE))
		expect(record?.sourceRecordID).toMatch(/^digest:[0-9a-f]{12}$/u)
	})

	it("splits a unit written at the end of the street when the run's unit column is empty", async () => {
		const units = await createUnitSplitter()
		const base = { lon: "-121.28801", lat: "38.74546", number: "100", postcode: "95678" }

		// Placer County's run writes `VERNON ST APT 114` with an empty UNIT column.
		const split = openAddressesAddressRecord({ ...base, street: "VERNON ST APT 114" }, "us/ca/placer", US, units)

		expect(split?.streetRaw).toBe("VERNON ST")
		expect(split?.unit).toBe("APT 114")
		expect(split?.streetKey).toBe(normalizeStreetForKeyLocale("VERNON ST", US))

		// A stated unit is kept, and its street is left as written.
		const stated = openAddressesAddressRecord(
			{ ...base, street: "VERNON ST APT 114", unit: "114" },
			"us/ca/placer",
			US,
			units
		)

		expect(stated?.streetRaw).toBe("VERNON ST APT 114")
		expect(stated?.unit).toBe("114")
		// Without a splitter the street is kept as written.
		expect(openAddressesAddressRecord({ ...base, street: "VERNON ST APT 114" }, "us/ca/placer", US)?.unit).toBeNull()
	})

	it("removes a trailing city, state and ZIP only when each repeats the row's own fields", () => {
		const base = { lon: "-103.2077", lat: "40.6255", number: "514", city: "STERLING", hash: "a1" }
		const street = (row: Record<string, string>) => openAddressesAddressRecord({ ...base, ...row }, "us/co/logan", US)

		// The state may come from REGION or from the run's subdivision, and the ZIP may be the ZIP+4 form.
		expect(street({ street: "CHURCH ST STERLING, CO 80751", postcode: "80751" })?.streetRaw).toBe("CHURCH ST")
		expect(street({ street: "CHURCH ST, Sterling, CO 80751-1234", postcode: "80751" })?.streetRaw).toBe("CHURCH ST")
		expect(street({ street: "CHURCH ST STERLING CO", region: "CO" })?.streetRaw).toBe("CHURCH ST")
		expect(street({ street: "CHURCH ST STERLING 80751", postcode: "80751" })?.streetRaw).toBe("CHURCH ST")

		// A tail naming another town or another ZIP, a bare trailing city, and a row with no CITY keep their street.
		expect(street({ street: "CHURCH ST ILIFF, CO 80736", postcode: "80736" })?.streetRaw).toBe(
			"CHURCH ST ILIFF, CO 80736"
		)

		expect(street({ street: "CHURCH ST STERLING, CO 80736", postcode: "80751" })?.streetRaw).toBe(
			"CHURCH ST STERLING, CO 80736"
		)

		expect(street({ street: "OLD STERLING" })?.streetRaw).toBe("OLD STERLING")
		// A separator before the place goes with it, and a remainder of one short word keeps the street.
		expect(street({ street: "PARK ST - STERLING CO" })?.streetRaw).toBe("PARK ST")
		expect(street({ street: "K & H ST, STERLING, CO" })?.streetRaw).toBe("K & H ST")
		expect(street({ street: "E STERLING CO" })?.streetRaw).toBe("E STERLING CO")
		expect(street({ street: "CHURCH ST WRANGELL, AK 99929", city: "" })?.streetRaw).toBe("CHURCH ST WRANGELL, AK 99929")

		// The digest identifier reads the street as written.
		expect(
			openAddressesAddressRecord(
				{ ...base, hash: "", street: "CHURCH ST STERLING, CO 80751", postcode: "80751" },
				"us/co/logan",
				US
			)?.sourceRecordID
		).not.toBe(
			openAddressesAddressRecord({ ...base, hash: "", street: "CHURCH ST", postcode: "80751" }, "us/co/logan", US)
				?.sourceRecordID
		)
	})
})
