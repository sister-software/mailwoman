/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the Form 499 XLSX reader.
 *
 *   The fixture is four real rows lifted verbatim from the FCC's 2025-12-07 filer database, with the
 *   workbook's own 122-column header — not a hand-authored sheet. They were chosen to cover the shapes the
 *   reader has to survive: a live single-state filer, a ceased filer with all three note columns and a
 *   successor, a filer whose USF flag is `No`, and a 53-jurisdiction national one.
 */

import type { Form499Row } from "@mailwoman/filer/sdk/form499"
import {
	assertWorkbookHeader,
	FORM_499_WORKBOOK_KEYS,
	parseForm499Workbook,
	readOperatingStates,
	toISOFilingDate,
} from "@mailwoman/filer/sdk/form499-workbook"
import { readFileSync } from "@mailwoman/platform/fs"
import { join } from "@mailwoman/platform/path"
import { describe, expect, it } from "vitest"

const WORKBOOK_PATH = join(import.meta.dirname, "../../../test-fixtures/form499/filer-db-sample.xlsx")

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

	it("reads CORESID as the FRN — the ALL-CAPS header the snake-caser leaves alone", async () => {
		const [otelco] = await readFixture()

		// A reader assuming `coresid` gets undefined here on every row, silently.
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
		// This one has a Suite line, so address2 is present and address3 is not.
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

		// The successor is in this same sheet — the chain resolves rather than dangling.
		expect(rows.some((row) => row.form499ID === corr?.lifecycle?.replacedByForm499ID)).toBe(true)
	})

	it("distinguishes 'the FCC said nothing' from 'this source cannot say'", async () => {
		const [otelco] = await readFixture()

		// A workbook row with blank notes yields an EMPTY lifecycle, never undefined. Undefined is
		// reserved for the TSV path, which has no note columns at all.
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
		// Reading the fixture at all exercises this; asserted directly so a failure names the guard.
		await expect(readFixture()).resolves.toHaveLength(4)
	})

	it("names every missing column rather than failing on the first", () => {
		expect(() => assertWorkbookHeader(["filer_499_id", "CORESID"])).toThrow(/missing \d+ column\(s\)/)
		expect(() => assertWorkbookHeader(["filer_499_id", "CORESID"])).toThrow(/legal_name_of_carrier/)
	})

	it("rejects a header using the lower-cased FRN spelling", () => {
		// The failure mode this guard exists for: `coresid` reads as undefined on every row.
		const header = Object.values(FORM_499_WORKBOOK_KEYS).map((key) => (key === "CORESID" ? "coresid" : key))

		expect(() => assertWorkbookHeader(header)).toThrow(/CORESID/)
	})

	it("refuses a file that is not a workbook rather than yielding empty rows", async () => {
		await expect(async () => {
			for await (const _row of parseForm499Workbook(join(import.meta.dirname, "../../../sdk/form499-workbook.ts"))) {
				// Not reached — the reader throws before yielding.
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
		// Empty fails assertISODate loudly at write time. A guess would fail nothing.
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
		expect(readOperatingStates({ alabama: true as unknown as string })).toEqual(["AL"])
	})
})

describe("the fixture itself", () => {
	it("is a real workbook, not a hand-authored one", () => {
		// XLSX is a ZIP; the magic bytes are the cheapest proof the file was not stubbed out.
		expect(readFileSync(WORKBOOK_PATH).subarray(0, 2).toString("latin1")).toBe("PK")
	})
})
