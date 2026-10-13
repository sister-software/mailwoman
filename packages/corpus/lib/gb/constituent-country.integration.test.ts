/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createLayerCoverageTable, createLayerManifestTable } from "@mailwoman/core/layers"
import {
	compactPostcode,
	createNSULIndexes,
	createUPRNPostcodeTable,
	type NSULDatabase,
} from "@mailwoman/resolver-wof-sqlite/nsul"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { openConstituentCountryReader, type ConstituentCountryAnswer } from "#gb/constituent-country"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A Welsh postcode, a Shrewsbury postcode in the `SY` area the codex assigns to Wales,
 * and a border postcode whose UPRNs lie in both countries.
 */
const ROWS = [
	{ uprn: 1, pcds: "SY23 2LN", ctry: "WLS" },
	{ uprn: 2, pcds: "SY1 1AA", ctry: "ENG" },
	{ uprn: 3, pcds: "SY10 7XX", ctry: "WLS" },
	{ uprn: 4, pcds: "SY10 7XX", ctry: "WLS" },
	{ uprn: 5, pcds: "SY10 7XX", ctry: "ENG" },
]

let countryOf: (postcode: string) => ConstituentCountryAnswer

beforeAll(async () => {
	const dir = fixtures.use(await temporaryDirectory("gb-constituent-country-")).path
	const databasePath = dir("nsul.db")

	{
		using kdb = new DatabaseClient<NSULDatabase>(databasePath)

		await createUPRNPostcodeTable(kdb)
		await createLayerManifestTable(kdb)
		await createLayerCoverageTable(kdb)

		const insert = kdb.prepare(
			"INSERT INTO uprn_postcode (uprn, pcds, pcds_compact, ctry, lat, lon, h3_cell) VALUES (?, ?, ?, ?, 0, 0, 0)"
		)

		for (const row of ROWS) {
			insert.run(row.uprn, row.pcds, compactPostcode(row.pcds), row.ctry)
		}

		await createNSULIndexes(kdb)
	}

	countryOf = openConstituentCountryReader(databasePath)
})

describe("openConstituentCountryReader", () => {
	it("answers the country NSUL records, including an English postcode in a Welsh-majority area", () => {
		expect(countryOf("SY23 2LN")).toEqual({ name: "Wales", straddles: false })
		expect(countryOf("SY1 1AA")).toEqual({ name: "England", straddles: false })
	})

	it("answers the majority country for a border postcode and reports that it straddles", () => {
		expect(countryOf("SY107XX")).toEqual({ name: "Wales", straddles: true })
	})

	it("answers no name for a postcode the register does not hold", () => {
		expect(countryOf("SW1A 1AA")).toEqual({ name: null, straddles: false })
	})
})
