/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import {
	componentsForIsleOfManLandTransactionRecord,
	createIsleOfManLandRegistryAdapter,
	LANDREGISTRY_IM_ADAPTER_ID,
	LANDREGISTRY_IM_LICENSE,
	type IsleOfManLandTransactionRecord,
} from "#im/adapters/land-registry/adapter"
import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"

const scratch = useScratchDir("landregistry-im")

const HEADER =
	"SubUnit_Name,House_Number,House_Name,Street_Name,Locality,Town,Postcode,Parish_,Market_Value,Consideration,Acquisition_Date,CompletionDate"

/**
 * Lines copied from `landtransactionsjan2025.csv`: a repeat sale of one house, quoted prices,
 * a leading space in `House_Number`, a land parcel, and a garage sold on its own.
 */
const LINES = [
	",,Field North Of Ballawhannel Farm,Lhen Road,,Bride,,Bride,,475.00,21/04/1975,11/04/2001",
	',,Starvold,Bride Road,,Bride,IM7 4AE,Bride,,"345,000.00",19/07/2002,14/08/2002',
	', 96,,Hailwood Avenue,Governors Hill,Douglas,,Onchan,"192,500.00","192,500.00",09/05/2012,24/08/2012',
	', 96,,Hailwood Avenue,Governors Hill,Douglas,,Onchan,"189,000.00","189,000.00",15/12/2014,16/03/2015',
	'Apartment 57,,Spectrum Apartments,Central Promenade,,Douglas,IM2 4LL,Onchan,"117,500.00","117,500.00",17/04/2009,29/08/2009',
	'Garage 1,,Isle Of Alanis,Mooragh Promenade,,Ramsey,IM8 3AJ,Lezayre,"7,500.00","7,500.00",16/10/2009,10/12/2009',
]

const record = (fields: Partial<IsleOfManLandTransactionRecord>): IsleOfManLandTransactionRecord => ({
	SubUnit_Name: "",
	House_Number: "",
	House_Name: "",
	Street_Name: "",
	Locality: "",
	Town: "",
	Postcode: "",
	...fields,
})

describe("componentsForIsleOfManLandTransactionRecord", () => {
	it("reads a house name as the venue and the town as the locality", () => {
		expect(
			componentsForIsleOfManLandTransactionRecord(
				record({ House_Name: "Starvold", Street_Name: "Bride Road", Town: "Bride", Postcode: "IM7 4AE" })
			)
		).toEqual({ venue: "Starvold", street: "Bride Road", locality: "Bride", postcode: "IM7 4AE" })
	})

	it("keeps a flat designator as the unit beside the building name", () => {
		expect(
			componentsForIsleOfManLandTransactionRecord(
				record({
					SubUnit_Name: "Apartment 57",
					House_Name: "Spectrum Apartments",
					Street_Name: "Central Promenade",
					Town: "Douglas",
					Postcode: "IM2 4LL",
				})
			)
		).toEqual({
			unit: "Apartment 57",
			venue: "Spectrum Apartments",
			street: "Central Promenade",
			locality: "Douglas",
			postcode: "IM2 4LL",
		})
	})

	it("reads an estate as the dependent locality but not a second thoroughfare", () => {
		const dropped = new Map<string, number>()

		expect(
			componentsForIsleOfManLandTransactionRecord(
				record({ House_Number: " 18", Street_Name: "Hillberry Meadows", Locality: "Governors Hill", Town: "Douglas" }),
				{ dropped }
			)
		).toEqual({
			house_number: "18",
			street: "Hillberry Meadows",
			dependent_locality: "Governors Hill",
			locality: "Douglas",
		})

		expect(
			componentsForIsleOfManLandTransactionRecord(
				record({
					House_Number: " 2",
					Street_Name: "Ballamoar Cottages",
					Locality: "Main Road",
					Town: "Ballaugh",
					Postcode: "IM7 5EE",
				}),
				{ dropped }
			)
		).toEqual({ house_number: "2", street: "Ballamoar Cottages", locality: "Ballaugh", postcode: "IM7 5EE" })

		expect(Object.fromEntries(dropped)).toEqual({ "component:dependent_locality:thoroughfare": 1 })
	})

	it("drops a postcode outside the IM format, a door pair, and a name that opens with a number", () => {
		const dropped = new Map<string, number>()

		expect(
			componentsForIsleOfManLandTransactionRecord(
				record({
					SubUnit_Name: "Unit 1",
					Street_Name: "Balthane Park Industrial Estate",
					Locality: "Balthane",
					Town: "Malew",
					Postcode: "1M9 2AX",
				}),
				{ dropped }
			)
		).toBeNull()

		expect(
			componentsForIsleOfManLandTransactionRecord(
				record({
					House_Number: " 11/12",
					House_Name: "Apartment 9",
					Street_Name: "Peel Road",
					Town: "Douglas",
					Postcode: "IM1 4LR",
				}),
				{ dropped }
			)
		).toBeNull()

		expect(
			componentsForIsleOfManLandTransactionRecord(
				record({ House_Name: "15 Godred Court", Street_Name: "Kings Reach", Town: "Ramsey", Postcode: "IM8 3NY" }),
				{ dropped }
			)
		).toBeNull()

		expect(Object.fromEntries(dropped)).toEqual({
			"component:house_number:not-one-number": 1,
			"component:venue:holds-a-number": 1,
			"row:no-house-number-or-name": 3,
		})
	})

	it("refuses land parcels, structures sold apart from a dwelling, and sales of several properties", () => {
		const dropped = new Map<string, number>()

		const refuse = (fields: Partial<IsleOfManLandTransactionRecord>) =>
			componentsForIsleOfManLandTransactionRecord(record({ Town: "Bride", ...fields }), { dropped })

		expect(refuse({ House_Name: "Field North Of Ballawhannel Farm", Street_Name: "Lhen Road" })).toBeNull()
		expect(refuse({ Street_Name: "Land Abutting Kionlough Road", Locality: "Ballavair" })).toBeNull()
		expect(refuse({ House_Name: "Bride Service Reservoir", Street_Name: "Lhen Road" })).toBeNull()

		expect(
			refuse({ SubUnit_Name: "Garage 1", House_Name: "Isle Of Alanis", Street_Name: "Mooragh Promenade" })
		).toBeNull()

		expect(refuse({ House_Name: "Gorse Cottage And Willow Cottage", Street_Name: "Ballaterson Beg" })).toBeNull()

		expect(Object.fromEntries(dropped)).toEqual({
			"row:land-parcel-description": 2,
			"row:not-a-premise": 2,
			"row:several-properties": 1,
		})
	})
})

describe("landregistry-im adapter", () => {
	it("emits each property once, reads no price columns, and stamps the license", async () => {
		const input = scratch.path("landtransactions.csv")

		await writeLocalTextFile("﻿" + [HEADER, ...LINES].join("\r\n") + "\r\n", input)

		const dropped = new Map<string, number>()

		const manifest = await runAdapter({
			adapter: createIsleOfManLandRegistryAdapter(),
			adapterOptions: { inputPath: input, country: "IM", dropped },
			outputDir: scratch.path,
			corpusVersion: "0.1.0",
		})

		expect(manifest.yielded).toBe(3)

		const rows = await readCanonicalRows(scratch.path, LANDREGISTRY_IM_ADAPTER_ID)

		expect(rows.every((row) => row.license === LANDREGISTRY_IM_LICENSE && row.country === "IM")).toBe(true)
		expect(rows.map((row) => row.raw)).toContain("Starvold, Bride Road, Bride, IM7 4AE")
		expect(rows.map((row) => row.raw)).toContain("96 Hailwood Avenue, Governors Hill, Douglas")
		expect(rows.some((row) => /\d{2},\d{3}|\d{2}\/\d{2}\/\d{4}/u.test(row.raw))).toBe(false)
		expect(dropped.get("row:repeat-sale")).toBe(1)
	})
})
