/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the Form 499 xlsx reader.
 *
 *   The fixture holds four unedited rows from the FCC filer database with the full 122-column header. The rows
 *   cover a live single-state filer, a ceased filer with a successor, a filer whose USF flag is `No` and a
 *   national filer in 53 jurisdictions.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import type { Form499Row } from "@mailwoman/filer/sdk/form499"
import {
	assertWorkbookHeader,
	FORM_499_WORKBOOK_KEYS,
	parseForm499Workbook,
	readOperatingStates,
	toISOFilingDate,
} from "@mailwoman/filer/sdk/form499-workbook"
import { describe, expect, it } from "vitest"

const WORKBOOK_PATH = resolvePackagePath("@mailwoman/filer", "test-fixtures", "form499", "filer-db-sample.xlsx")

async function readFixture(): Promise<Form499Row[]> {
	const rows: Form499Row[] = []

	for await (const row of parseForm499Workbook(WORKBOOK_PATH)) {
		rows.push(row)
	}

	return rows
}

describe("parseForm499Workbook — real FCC rows", () => {
	it("reads every filer in the sheet", async () => {
		expect((await readFixture()).map((row) => row.form499ID)).toEqual(["801003", "801004", "802131", "821002"])
	})

	it("reads the FRN, whatever case the FCC ships the column in", async () => {
		const [otelco] = await readFixture()

		expect(otelco?.frn).toBe("0018538512")
	})

	it("converts the M/D/YYYY filing date to ISO, because it becomes valid_from", async () => {
		const rows = await readFixture()

		expect(rows.map((row) => row.lastFiledAt)).toEqual(["2025-04-01", "2014-04-01", "2025-04-01", "2025-04-01"])
	})

	it("reads the Yes/No USF flag, which a pass-through would make uniformly false", async () => {
		const rows = await readFixture()

		expect(rows.map((row) => row.usfContributor)).toEqual([true, false, true, true])
	})

	it("joins the six address columns into one line, skipping the blanks", async () => {
		const rows = await readFixture()

		expect(rows[0]?.hqAddress).toBe("505 Third Avenue East Oneonta AL 35121")
		// This row has a suite line in address2 and a blank address3.
		expect(rows[1]?.hqAddress).toBe("1018 Highland Colony Parkway Suite 330 Ridgeland MS 39157")
	})

	it("reads the DC agent email from `dc_agent_e_mail`", async () => {
		expect((await readFixture())[0]?.dcAgentEmailAddress).toBe("STATREP@COGENCYGLOBAL.COM")
	})

	it("keeps holding company and management company as separate assertions", async () => {
		const [otelco] = await readFixture()

		expect(otelco?.holdingCompany).toBe("OTELCO INC")
		expect(otelco?.managementCompany).toBe("")
	})
})

describe("parseForm499Workbook — lifecycle and footprint", () => {
	it("recovers a dated acquisition with a resolvable successor", async () => {
		const rows = await readFixture()
		const corr = rows.find((row) => row.form499ID === "801004")

		expect(corr?.lifecycle).toMatchObject({
			ceasedAt: "2013-09-08",
			replacedByForm499ID: "821002",
			unrecognized: 0,
		})

		// The successor is another row in the same sheet.
		expect(rows.some((row) => row.form499ID === corr?.lifecycle?.replacedByForm499ID)).toBe(true)
	})

	it("distinguishes 'the FCC said nothing' from 'this source cannot say'", async () => {
		const [otelco] = await readFixture()

		// A workbook row with blank notes has an empty lifecycle.
		// Only TSV rows leave it undefined.
		expect(otelco?.lifecycle).toEqual({ notes: [], reasons: [], unrecognized: 0 })
		expect(otelco?.lifecycle).toBeDefined()
	})

	it("reads the operating footprint as sorted USPS codes", async () => {
		const rows = await readFixture()

		expect(rows.find((row) => row.form499ID === "801003")?.operatingStates).toEqual(["AL"])
		expect(rows.find((row) => row.form499ID === "801004")?.operatingStates).toEqual(["AL", "GA"])
		expect(rows.find((row) => row.form499ID === "802131")?.operatingStates).toEqual(["WY"])
	})

	it("reads a national filer's whole footprint, territories included", async () => {
		const national = (await readFixture()).find((row) => row.form499ID === "821002")

		expect(national?.operatingStates?.length).toBe(53)
		expect(national?.operatingStates).toContain("PR")
		expect(national?.operatingStates).toContain("VI")
		expect(national?.operatingStates).toContain("DC")
	})
})

describe("assertWorkbookHeader", () => {
	it("accepts the real workbook's header", async () => {
		// Reading the fixture runs the header check.
		await expect(readFixture()).resolves.toHaveLength(4)
	})

	it("names every missing column rather than failing on the first", () => {
		expect(() => assertWorkbookHeader(["filer_499_id", "CORESID"])).toThrow(/missing \d+ column\(s\)/)
		expect(() => assertWorkbookHeader(["filer_499_id", "CORESID"])).toThrow(/legal_name_of_carrier/)
	})

	it("rejects a header whose FRN column is not the lower-cased key", () => {
		const header = Object.values(FORM_499_WORKBOOK_KEYS).map((key) => (key === "coresid" ? "CORESID" : key))

		expect(() => assertWorkbookHeader(header)).toThrow(/coresid/)
	})

	it("refuses a file that is not a workbook rather than yielding empty rows", async () => {
		await expect(async () => {
			for await (const _row of parseForm499Workbook(
				resolvePackagePath("@mailwoman/filer", "lib", "sdk", "form499-workbook.ts")
			)) {
				// The reader throws before yielding a row.
			}
		}).rejects.toThrow(/./)
	})
})

describe("toISOFilingDate", () => {
	it("converts and zero-pads", () => {
		expect(toISOFilingDate("4/1/2025")).toBe("2025-04-01")
		expect(toISOFilingDate("12/31/2018")).toBe("2018-12-31")
	})

	it("passes an already-ISO value through, for a workbook with real date cells", () => {
		expect(toISOFilingDate("2025-04-01")).toBe("2025-04-01")
	})

	it("returns empty for anything else rather than inventing a date", () => {
		// An empty result makes `assertISODate` throw when the builder writes the row.
		expect(toISOFilingDate("")).toBe("")
		expect(toISOFilingDate("2026-Q2")).toBe("")
		expect(toISOFilingDate("April 1, 2025")).toBe("")
	})
})

describe("readOperatingStates", () => {
	it("reads only the TRUE columns, sorted", () => {
		expect(readOperatingStates({ alabama: "TRUE", alaska: "FALSE", wyoming: "TRUE", georgia: null })).toEqual([
			"AL",
			"WY",
		])
	})

	it("is empty when no jurisdiction is marked", () => {
		expect(readOperatingStates({ alabama: "FALSE", wyoming: "FALSE" })).toEqual([])
	})

	it("accepts a real boolean cell, since a transformer may have typed the column", () => {
		expect(readOperatingStates({ alabama: true })).toEqual(["AL"])
	})
})

describe("the fixture itself", () => {
	it("is a real workbook, not a hand-authored one", async () => {
		// An xlsx file is a ZIP archive, which starts with "PK".
		expect((await readLocalBuffer(WORKBOOK_PATH)).subarray(0, 2).toString("latin1")).toBe("PK")
	})
})
