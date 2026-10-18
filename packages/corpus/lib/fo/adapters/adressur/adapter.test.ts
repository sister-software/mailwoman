/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import {
	ADRESSUR_FO_ADAPTER_ID,
	ADRESSUR_FO_LICENSE,
	type AdressurRecord,
	componentsForAdressurRecord,
	createAdressurFaroeAdapter,
} from "#fo/adapters/adressur/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("adressur-fo")

/**
 * Feature properties copied from the `us_adr_husanr` layer, keeping the columns the
 * adapter reads beside `house_no` and `municipality`, which it does not.
 */
const RECORDS = [
	{
		address_id: 33_358,
		house_no: "20",
		house_digit: 20,
		house_letter: "",
		street_name: "Eystara Bryggja",
		zip: 100,
		city: "Tórshavn",
		municipality: "Tórshavnar",
	},
	{
		address_id: 7273,
		house_no: "4B",
		house_digit: 4,
		house_letter: "B",
		street_name: "Ravnsoyargøta",
		zip: 100,
		city: "Tórshavn",
		municipality: "Tórshavnar",
	},
	{
		address_id: 16_307,
		house_no: "9",
		house_digit: 9,
		house_letter: "",
		street_name: "Agnið",
		zip: 655,
		city: "Nes, Eysturoy",
		municipality: "Nes",
	},
	{
		address_id: 31_518,
		house_no: "1",
		house_digit: 1,
		house_letter: "",
		street_name: "Dalsgøta",
		zip: 795,
		city: "Syðradalur, Kalsoy",
		municipality: "Klaksvíkar",
	},
	{
		address_id: 26_645,
		house_no: "15",
		house_digit: 15,
		house_letter: "",
		street_name: "Suðuri á Bø",
		zip: 780,
		city: "Kunoy",
		municipality: "Kunoyar",
	},
	{
		address_id: 15_495,
		house_no: "34A",
		house_digit: 34,
		house_letter: "A",
		street_name: "Stoksoyrarvegur",
		zip: 700,
		city: "Klaksvík",
		municipality: "Klaksvíkar",
	},
] satisfies Array<AdressurRecord & { house_no: string; municipality: string }>

describe("componentsForAdressurRecord", () => {
	it("joins the house letter to the digit as the register's own house_no writes it", () => {
		for (const record of RECORDS) {
			expect(componentsForAdressurRecord(record)?.house_number).toBe(record.house_no)
		}

		expect(componentsForAdressurRecord(RECORDS[1]!)).toEqual({
			street: "Ravnsoyargøta",
			house_number: "4B",
			postcode: "100",
			locality: "Tórshavn",
		})
	})

	it("keeps a postal locality's disambiguating comma and leaves the municipality out", () => {
		expect(componentsForAdressurRecord(RECORDS[2]!)).toEqual({
			street: "Agnið",
			house_number: "9",
			postcode: "655",
			locality: "Nes, Eysturoy",
		})
	})

	it("refuses a row with no street or no number, and drops a postcode outside the format", () => {
		const dropped = new Map<string, number>()

		expect(componentsForAdressurRecord({ ...RECORDS[0]!, street_name: " " }, { dropped })).toBeNull()
		expect(componentsForAdressurRecord({ ...RECORDS[0]!, house_digit: null }, { dropped })).toBeNull()
		expect(componentsForAdressurRecord({ ...RECORDS[0]!, zip: 1000 }, { dropped })?.postcode).toBeUndefined()

		expect(Object.fromEntries(dropped)).toEqual({
			"row:no-street": 1,
			"row:no-house-number": 1,
			"component:postcode:not-country-format": 1,
		})
	})
})

describe("adressur-fo adapter", () => {
	it("reads the layer's GeoJSON, renders the FO layout and stamps Umhvørvisstovan's terms", async () => {
		const file = scratch.path("us_adr_husanr.geojson")

		const collection = {
			type: "FeatureCollection",
			features: RECORDS.map((properties) => ({
				type: "Feature",
				geometry: { type: "Point", coordinates: [-6.76, 62] },
				properties,
			})),
		}

		await writeLocalTextFile(stringifyJSON(collection), file)

		const dropped = new Map<string, number>()

		const manifest = await runAdapter({
			adapter: createAdressurFaroeAdapter(),
			adapterOptions: { inputPath: file, country: "FO", dropped },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(RECORDS.length)

		const rows = await readCanonicalRows(scratch.path, ADRESSUR_FO_ADAPTER_ID)

		expect(rows.every((row) => row.license === ADRESSUR_FO_LICENSE && row.country === "FO")).toBe(true)
		expect(rows.map((row) => row.raw)).toContain("Suðuri á Bø 15, FO780 Kunoy")
		expect(new Set(rows.map((row) => row.source_id)).size).toBe(RECORDS.length)
		expect(dropped.size).toBe(0)
	})

	it("refuses another country", async () => {
		await expect(
			Array.fromAsync(createAdressurFaroeAdapter().rows({ inputPath: "unused.geojson", country: "DK" }))
		).rejects.toThrow(/adressur-fo/u)
	})
})
