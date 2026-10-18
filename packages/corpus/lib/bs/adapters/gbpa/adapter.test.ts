/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import {
	componentsForGBPARecord,
	createGBPAAdapter,
	GBPA_BS_ADAPTER_ID,
	GBPA_BS_LICENSE,
	type GBPAAddressRecord,
} from "#bs/adapters/gbpa/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("gbpa-bs")

const HEADER =
	"Y,X,OBJECTID,AddID,ParcelNumb,BlkNumber,AltName,Prefix,StreetName,Suffix,FullStName,Address,AddressNum,City,Island"

/**
 * Lines copied from `CSV/addresses.csv`, including its one record shape with a quoted line break.
 */
const LINES = [
	"26.5016896365876,-78.6576869712632,1,0000001,29,8,,,Seagull,Drive,Seagull Drive,8-29 Seagull Drive,8-29,Freeport,Grand Bahama",
	"26.5458666403077,-78.5938799169118,3929,0003929,3,B,Lucayan International School,,Chesapeake,Drive,Chesapeake Drive,B-3 Chesapeake Drive,B-3,Lucaya,Grand Bahama",
	'26.5036077211727,-78.7035821387919,1938,0001938,43C,13,,,"Santa Maria \r\nSanta Maria",Avenue,"Santa Maria \r\nSanta Maria Avenue","13-43C Santa Maria \r\nSanta Maria Avenue",13-43C,Freeport,Grand Bahama',
	"26.520393167779,-78.6719787626841,35635,0035635,Minis*,,,,Beachway,Drive,Beachway Drive,Minis* Beachway Drive,Minis*,Freeport,Grand Bahama",
	"26.534521218025,-78.6463360300465,24969,0024969,22,9,,,Lane,Lane,Lane,9-22  Lane,9-22,Lucaya,Grand Bahama",
]

const record = (fields: Partial<GBPAAddressRecord>): GBPAAddressRecord => ({
	Y: "0",
	X: "0",
	AddID: "0000000",
	AltName: "",
	Suffix: "",
	FullStName: "",
	AddressNum: "",
	City: "",
	Island: "",
	...fields,
})

describe("componentsForGBPARecord", () => {
	it("reads a block-parcel number, the street, the city and the island", () => {
		expect(
			componentsForGBPARecord(
				record({ AddressNum: "8-29", FullStName: "Seagull Drive", City: "Freeport", Island: "Grand Bahama" })
			)
		).toEqual({ house_number: "8-29", street: "Seagull Drive", locality: "Freeport", region: "Grand Bahama" })

		expect(
			componentsForGBPARecord(
				record({ AddressNum: "W-A-10", FullStName: "Grenville Drive", City: "Freeport", Island: "Grand Bahama" })
			)?.house_number
		).toBe("W-A-10")
	})

	it("keeps a business or school name as the venue, and a venue alone when the point has no number", () => {
		expect(
			componentsForGBPARecord(
				record({
					AltName: "Lucayan International School",
					AddressNum: "B-3",
					FullStName: "Chesapeake Drive",
					City: "Lucaya",
				})
			)?.venue
		).toBe("Lucayan International School")

		expect(
			componentsForGBPARecord(
				record({ AltName: "Tony Macaroni's Conch Experience", FullStName: "West Beach Road", City: "Lucaya" })
			)
		).toEqual({ venue: "Tony Macaroni's Conch Experience", street: "West Beach Road", locality: "Lucaya" })
	})

	it("drops a person's initials and surname, a run of repeated keystrokes, and a truncated number", () => {
		const dropped = new Map<string, number>()

		const read = (fields: Partial<GBPAAddressRecord>) =>
			componentsForGBPARecord(record({ FullStName: "Settlers Drive", City: "Freeport", ...fields }), { dropped })

		expect(read({ AltName: "J.S. Johnson", AddressNum: "A-2A" })).toEqual({
			house_number: "A-2A",
			street: "Settlers Drive",
			locality: "Freeport",
		})

		expect(read({ AltName: "Bellevue Gifts & Suppliesccccc", AddressNum: "I-4" })?.venue).toBeUndefined()
		expect(read({ AddressNum: "Minis*" })).toBeNull()

		expect(Object.fromEntries(dropped)).toEqual({
			"component:venue:names-a-person": 1,
			"component:venue:malformed": 1,
			"component:house_number:truncated": 1,
			"row:no-house-number-or-name": 1,
		})
	})

	it("collapses a repeated street name and refuses a street that is only a type word", () => {
		const dropped = new Map<string, number>()

		expect(
			componentsForGBPARecord(
				record({ AddressNum: "13-43C", FullStName: "Santa Maria \r\nSanta Maria Avenue", City: "Freeport" }),
				{ dropped }
			)?.street
		).toBe("Santa Maria Avenue")

		expect(
			componentsForGBPARecord(record({ AddressNum: "92-1", FullStName: "Rippindale Rippindale", City: "Lucaya" }), {
				dropped,
			})?.street
		).toBe("Rippindale")

		expect(
			componentsForGBPARecord(record({ AddressNum: "9-22", FullStName: "Lane", City: "Lucaya" }), { dropped })
		).toBeNull()

		expect(Object.fromEntries(dropped)).toEqual({
			"component:street:repeated-name-collapsed": 2,
			"row:street-is-a-type-word": 1,
		})
	})
})

describe("gbpa-bs adapter", () => {
	it("reads the BOM-prefixed CRLF export, including a quoted line break, and stamps the license", async () => {
		const input = scratch.path("addresses.csv")

		await writeLocalTextFile("﻿" + [HEADER, ...LINES].join("\r\n") + "\r\n", input)

		const manifest = await runAdapter({
			adapter: createGBPAAdapter(),
			adapterOptions: { inputPath: input, country: "BS" },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(3)

		const rows = await readCanonicalRows(scratch.path, GBPA_BS_ADAPTER_ID)

		expect(rows.every((row) => row.license === GBPA_BS_LICENSE && row.country === "BS")).toBe(true)

		expect(rows.find((row) => row.components.house_number === "8-29")?.components).toEqual({
			house_number: "8-29",
			street: "Seagull Drive",
			locality: "Freeport",
			region: "Grand Bahama",
		})

		expect(rows.some((row) => row.components.street === "Santa Maria Avenue")).toBe(true)
		expect(new Set(rows.map((row) => row.source_id)).size).toBe(3)
	})
})
