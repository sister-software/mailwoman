// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { PathBuilder, PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import { recordIDOf } from "#adapters/record-id"
import { NAD_FIXTURE, useScratchDir, writeNADReleaseParquet } from "#test-kit"
import type { CanonicalRow } from "#types"
import {
	createUsgovNADAdapter,
	nadAddressComponents,
	nadUnitText,
	normalizeNADRecord,
	normalizeNADUUID,
	USGOV_NAD_ADAPTER_ID,
	USGOV_NAD_DEFAULT_LICENSE,
} from "#us/adapters/usgov/nad/adapter"

const FIXTURE = NAD_FIXTURE

const scratch = useScratchDir("usgov-nad")

function writeReleaseParquet(records: ReadonlyArray<Record<string, unknown>>): Promise<PathBuilder> {
	return writeNADReleaseParquet(scratch.path, records)
}

function fixtureParquet(): Promise<PathBuilder> {
	return writeNADReleaseParquet(scratch.path)
}

async function collect(
	adapter = createUsgovNADAdapter(),
	opts: { country?: string; limit?: number } = {},
	inputPath?: PathBuilderLike
) {
	const out: CanonicalRow[] = []

	for await (const row of adapter.rows({ inputPath: inputPath ?? (await fixtureParquet()), ...opts })) {
		out.push(row)
	}

	return out
}

describe("usgov-nad adapter", () => {
	it("yields the expected count from the fixture (drops 3 invalid rows)", async () => {
		// fixture.ndjson has 12 rows: 9 valid, 3 dropped (empty Post_City, bad state ZZ, empty Zip_Code).
		const rows = await collect()
		expect(rows).toHaveLength(9)
	})

	it("reads a braced upper-case release UUID in the FeatureServer's lower-case form", async () => {
		expect(normalizeNADUUID("{0002173C-ADA8-4421-ACF2-F9B6F12B52F0}")).toBe("0002173c-ada8-4421-acf2-f9b6f12b52f0")
		expect(normalizeNADUUID("  ")).toBeNull()

		const parquetPath = await writeReleaseParquet([
			{
				OID_: 34_538_810,
				UUID: "{0002173C-ADA8-4421-ACF2-F9B6F12B52F0}",
				Add_Number: 390,
				AddNo_Full: "390",
				St_Name: "White Horse",
				St_PosTyp: "Court",
				StNam_Full: "White Horse Court",
				County: "Adams",
				Inc_Muni: "Town of Rome",
				Post_City: "Not stated",
				State: "WI",
				Zip_Code: "54457",
			},
		])

		const [row] = await collect(createUsgovNADAdapter(), {}, parquetPath)

		expect(row!.raw).toBe("390 White Horse Court, Town of Rome, WI 54457")
		expect(row!.source_id).toMatch(/^usgov-nad-0002173c-ada8-4421-acf2-f9b6f12b52f0-[0-9a-f]{12}$/u)
	})

	it("labels a place column that writes the record's own county as the subregion, and leaves a city named for its county a locality", async () => {
		// OID 16587994 and 73538981 of release 24, as published.
		const polk = {
			OID_: 16_587_994,
			UUID: "{FF8C1D86-330A-48E2-B804-26A796352719}",
			Add_Number: 1,
			AddNo_Full: "1",
			St_Name: "1st",
			St_PosTyp: "Street",
			StNam_Full: "1st Street",
			County: "Polk",
			Inc_Muni: "Polk County",
			Post_City: "Not stated",
			State: "OR",
			Zip_Code: "97347",
		}

		const denton = {
			OID_: 73_538_981,
			UUID: "{00023F69-CE5E-4DC7-9776-73973FF45E02}",
			Add_Number: 1408,
			AddNo_Full: "1408",
			St_Name: "VATTIER",
			St_PosTyp: "Street",
			StNam_Full: "VATTIER Street",
			County: "Denton",
			Inc_Muni: "DENTON COUNTY",
			Post_City: "DENTON COUNTY",
			State: "TX",
			Zip_Code: "75068",
		}

		const city = { ...denton, OID_: 1, UUID: "{00000000-0000-0000-0000-000000000001}", Post_City: "Denton" }
		const rows = await collect(createUsgovNADAdapter(), {}, await writeReleaseParquet([polk, denton, city]))

		const labeled = new Map(
			rows.map((row) => [row.raw, [row.components.subregion ?? null, row.components.locality ?? null]])
		)

		expect(Object.fromEntries(labeled)).toEqual({
			"1 1st Street, Polk County, OR 97347": ["Polk County", null],
			"1408 VATTIER Street, DENTON COUNTY, TX 75068": ["DENTON COUNTY", null],
			"1408 VATTIER Street, Denton, TX 75068": [null, "Denton"],
		})
	})

	it("composes a 4-component address with venue when LandmkName is set", async () => {
		const rows = await collect()
		const wh = rows.find((r) => r.components.venue === "The White House")
		expect(wh).toBeDefined()
		expect(wh!.components.locality).toBe("Washington")
		expect(wh!.components.region).toBe("DC")
		expect(wh!.components.postcode).toBe("20500")
		// Stage 3 decomposition: NAD's structured St_PreDir/St_Name/St_PosTyp/St_PosDir
		// become street_prefix/street/street_suffix.
		// Pennsylvania Avenue NW has no prefix — "Avenue" is St_PosTyp and "NW" is
		// St_PosDir, both → street_suffix.
		expect(wh!.components.street).toBe("Pennsylvania")
		expect(wh!.components.street_suffix).toBe("Avenue NW")
		expect(wh!.components.house_number).toBe("1600")
		expect(wh!.raw).toBe("The White House, 1600 Pennsylvania Avenue NW, Washington, DC 20500")
	})

	it("joins Zip_Code + Plus_4 into ZIP+4 form when both present", async () => {
		const rows = await collect()
		const oregon = rows.find((r) => r.components.locality === "Springfield")
		expect(oregon).toBeDefined()
		expect(oregon!.components.postcode).toBe("97477-1234")
		expect(oregon!.components.region).toBe("OR")
	})

	it("yields venue-only rows when no street parts are present", async () => {
		const rows = await collect()
		const ynp = rows.find((r) => r.components.venue === "Yellowstone National Park")
		expect(ynp).toBeDefined()
		expect(ynp!.components.house_number).toBeUndefined()
		expect(ynp!.components.street).toBeUndefined()
		expect(ynp!.components.locality).toBe("Yellowstone National Park")
		expect(ynp!.components.region).toBe("WY")
	})

	it("handles hyphenated NYC house numbers verbatim (40-12 Bell Blvd)", async () => {
		const rows = await collect()
		const nyc = rows.find((r) => r.components.house_number === "40-12")
		expect(nyc).toBeDefined()
		expect(nyc!.components.street).toBe("Bell")
		expect(nyc!.components.street_suffix).toBe("Blvd")
		expect(nyc!.components.locality).toBe("Bayside")
	})

	it("falls back to AddNum_Pre+Add_Number+AddNum_Suf when AddNo_Full is null", async () => {
		const rows = await collect()
		const vt = rows.find((r) => r.components.region === "VT")
		expect(vt).toBeDefined()
		expect(vt!.components.house_number).toBe("99 B")
	})

	it("decomposes St_PreDir + St_Name + St_PosTyp into Stage 3 components", async () => {
		const rows = await collect()
		const vt = rows.find((r) => r.components.region === "VT")
		expect(vt).toBeDefined()
		expect(vt!.components.street_prefix).toBe("N")
		expect(vt!.components.street).toBe("Maple")
		expect(vt!.components.street_suffix).toBe("St")
	})

	it("accepts PR territory", async () => {
		const rows = await collect()
		const pr = rows.find((r) => r.components.region === "PR")
		expect(pr).toBeDefined()
		expect(pr!.components.postcode).toBe("00901")
		expect(pr!.components.locality).toBe("San Juan")
	})

	it("rejects unknown state codes (ZZ)", async () => {
		const rows = await collect()
		expect(rows.find((r) => r.components.region === "ZZ")).toBeUndefined()
	})

	it("rejects rows with empty Zip_Code", async () => {
		const rows = await collect()
		// The CA row with Post_City="Anywhere" + empty Zip → dropped
		expect(rows.find((r) => r.components.locality === "Anywhere" && r.components.region === "CA")).toBeUndefined()
	})

	it("rejects rows with empty Post_City", async () => {
		const rows = await collect()
		// The NY row with empty Post_City + valid Zip 10001 → dropped (no locality alternates either)
		expect(rows.filter((r) => r.components.region === "NY" && r.components.postcode === "10001")).toHaveLength(0)
	})

	it("stamps source, locale, country, license consistently", async () => {
		const rows = await collect()

		for (const r of rows) {
			expect(r.source).toBe(USGOV_NAD_ADAPTER_ID)
			expect(r.country).toBe("US")
			expect(r.locale).toBe("en-US")
			expect(r.license).toBe(USGOV_NAD_DEFAULT_LICENSE)
			expect(r.source_id).toMatch(/^usgov-nad-/)
		}
	})

	it("keeps two addresses apart when NAD repeats a UUID or publishes the all-zero placeholder", async () => {
		const breed = {
			Add_Number: 6804,
			AddNo_Full: "6804",
			St_Name: "Breed",
			St_PosTyp: "Street",
			StNam_Full: "Breed Street",
			Post_City: "CHILTON",
			State: "WI",
			Zip_Code: "53014",
		}

		// Two records from NAD's own pages under UUID 79461b5e-…, and two under the placeholder.
		const records = [
			{ ...breed, OID_: 39_590_132, UUID: "79461b5e-7d9f-4fb2-baad-310a014e4bda" },
			{
				...breed,
				OID_: 70_311_605,
				UUID: "79461b5e-7d9f-4fb2-baad-310a014e4bda",
				Add_Number: 704,
				AddNo_Full: "704",
				St_PreDir: "West",
				StNam_Full: "West Breed Street",
			},
			{ ...breed, OID_: 1, UUID: "00000000-0000-0000-0000-000000000000", Add_Number: 10, AddNo_Full: "10" },
			{ ...breed, OID_: 2, UUID: "00000000-0000-0000-0000-000000000000", Add_Number: 12, AddNo_Full: "12" },
		]

		const rows = await collect(createUsgovNADAdapter(), {}, await writeReleaseParquet(records))
		const recordIDs = new Set(rows.map((row) => recordIDOf(row.source_id)))
		const byNumber = (number: string) => rows.find((row) => row.components.house_number === number)

		expect(rows).toHaveLength(records.length)
		expect(recordIDs.size).toBe(records.length)
		expect(byNumber("6804")!.source_id).toMatch(/^usgov-nad-79461b5e-7d9f-4fb2-baad-310a014e4bda-[0-9a-f]{12}$/u)
		expect(byNumber("10")!.source_id).toMatch(/^usgov-nad-1-[0-9a-f]{12}$/u)
	})

	it("yields, across consecutive row ranges, the rows of one full read in the same order", async () => {
		const adapter = createUsgovNADAdapter()
		const parquetPath = await fixtureParquet()
		const rows = await adapter.inputRowCount!({ inputPath: parquetPath })
		const full = await collect(adapter, {}, parquetPath)
		const ranged: CanonicalRow[] = []

		for (let start = 0; start < rows; start += 3) {
			for await (const row of adapter.rows({ inputPath: parquetPath, rowRange: { start, end: start + 3 } })) {
				ranged.push(row)
			}
		}

		expect(rows).toBeGreaterThan(6)
		expect(ranged).toEqual(full)
	})

	it("honors opts.limit (soft cap)", async () => {
		const rows = await collect(undefined, { limit: 3 })
		expect(rows).toHaveLength(3)
	})

	it("rejects non-US country filter", async () => {
		const adapter = createUsgovNADAdapter()

		const iterate = async () => {
			for await (const _ of adapter.rows({ inputPath: FIXTURE, country: "FR" })) {
				/* should throw before first yield */
			}
		}

		await expect(iterate()).rejects.toThrow(/only US supported/)
	})
})

describe("nadUnitText", () => {
	it.each([
		[{ Building: "BLDG 3", Unit: "APT 2" }, "BLDG 3 APT 2"],
		[{ Building: "Apartment 2", Unit: "Apartment 2" }, "Apartment 2"],
		[{ Floor: " FL 4 ", Room: "RM 410" }, "FL 4 RM 410"],
		[{ Unit: "#106" }, "#106"],
		[{ Building: " ", Unit: null }, null],
		// usgov-nad-2e53da72 and usgov-nad-4ae42d0f (#2895): the landmark or the street copied into `Unit`.
		[{ LandmkName: "RM ENERGY", Unit: "RM ENERGY" }, null],
		[{ St_PreDir: "South", St_Name: "DAUBE RANCH", St_PosTyp: "Road", Unit: "Daube Ranch" }, null],
		[{ StNam_Full: "MAIN STREET", Building: "MAIN STREET", Unit: "STE 4" }, "STE 4"],
		[{ LandmkName: "CITY HALL", St_Name: "MAIN", Unit: "SUITE 100" }, "SUITE 100"],
		[{ St_PreTyp: "Avenue", St_Name: "A", Building: "A", Unit: "Apartment 1" }, "A Apartment 1"],
		[{ St_PreTyp: "Highway", St_Name: "17", Unit: "17" }, "17"],
	])("composes %j as %j", (record, expected) => {
		expect(nadUnitText(record)).toBe(expected)
	})
})

describe("normalizeNADRecord", () => {
	// Spellings the r24 release writes in place of an empty value (#2895).
	it.each(["<Null>", "<NULL>", "NULL", "None", "N/A", "NA", "unknown", "--", ".", " <Null> "])(
		"reads LandmkName %j as absent, so no venue is emitted",
		(placeholder) => {
			const record = {
				LandmkName: placeholder,
				Add_Number: "12",
				St_Name: "MAIN",
				Inc_Muni: "Alma",
				State: "WI",
				Zip_Code: "54610",
			}

			expect(normalizeNADRecord(record).LandmkName).toBeNull()
			expect(nadAddressComponents(normalizeNADRecord(record))).not.toHaveProperty("venue")
		}
	)

	it("keeps a name that only contains a placeholder word, and Placement's own Unknown", () => {
		const record = { LandmkName: "NA Hospital", Unit: "None Such", Placement: "Unknown", UUID: "{AB-CD}" }

		expect(normalizeNADRecord(record)).toEqual({ ...record, UUID: "ab-cd" })
	})
})
