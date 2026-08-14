/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode parseForm499} (streaming TSV parser) and {@linkcode classifyFiler}
 *   (the ported `principalCommType` → {@linkcode FilerClassification} mapping, Nexus
 *   `universal-service.ts`:164-176).
 */

import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { classifyFiler, FilerClassification, FORM_499_COLUMNS, parseForm499, type Form499Row } from "./form499.ts"

const FIXTURES_DIR = join(import.meta.dirname, "..", "test-fixtures")
const SAMPLE_TSV = join(FIXTURES_DIR, "form499-sample.tsv")
const MALFORMED_TSV = join(FIXTURES_DIR, "form499-malformed.tsv")

async function collect(tsvPath: string): Promise<Form499Row[]> {
	const rows: Form499Row[] = []

	for await (const row of parseForm499(tsvPath)) {
		rows.push(row)
	}

	return rows
}

describe("FORM_499_COLUMNS", () => {
	it("carries all 17 column names from spec §3.1, in TSV order", () => {
		expect(FORM_499_COLUMNS).toHaveLength(17)
		expect(FORM_499_COLUMNS[0]).toBe("form499ID")
		expect(FORM_499_COLUMNS.at(-1)).toBe("dcAgentAddress")
	})

	it("does not carry otherTradeName1 — present in the Nexus interface but absent from its column tuple", () => {
		expect(FORM_499_COLUMNS as readonly string[]).not.toContain("otherTradeName1")
	})
})

describe("parseForm499", () => {
	it("parses a 3-row fixture into 3 typed rows", async () => {
		const rows = await collect(SAMPLE_TSV)

		expect(rows).toHaveLength(3)
	})

	it("parses each row's fields to the documented shape", async () => {
		const rows = await collect(SAMPLE_TSV)

		expect(rows[0]).toMatchObject({
			form499ID: "804981",
			frn: "0001753557",
			lastFiledAt: "2026-01-15",
			usfContributor: true,
			legalNameOfCarrier: "Example Telecom LLC",
			holdingCompany: "Example Holdings Inc",
			managementCompany: "Example Management Inc",
		})

		expect(rows[1]!.usfContributor).toBe(false)

		// Row 3's raw FRN in the fixture is unpadded (7 digits) — parseForm499 must zero-pad it via
		// toFRN, same as any other FRN source.
		expect(rows[2]!.frn).toBe("0003456789")
	})

	it("retains both holdingCompany and managementCompany as distinct fields (spec §3.1 finding 1)", async () => {
		const rows = await collect(SAMPLE_TSV)

		expect(rows[0]!.holdingCompany).toBe("Example Holdings Inc")
		expect(rows[0]!.managementCompany).toBe("Example Management Inc")
		expect(rows[0]!.holdingCompany).not.toBe(rows[0]!.managementCompany)
	})

	it("carries the DC agent fields as plain strings", async () => {
		const rows = await collect(SAMPLE_TSV)

		expect(rows[0]!.dcAgentDisplayName).toBe("CT Corporation System")
		expect(rows[0]!.dcAgentOrganizationName).toBe("CT Corporation System")
		expect(typeof rows[0]!.dcAgentAddress).toBe("string")
	})

	it("throws a descriptive error naming the file and line number for a short row", async () => {
		let caught: unknown

		try {
			await collect(MALFORMED_TSV)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain(MALFORMED_TSV)
		expect((caught as Error).message).toMatch(/line 2|:2\b/)
	})

	it("never yields a row from the malformed file before the throw — the first (valid) row is fine, but the second must reject", async () => {
		const rows: Form499Row[] = []
		let threw = false

		try {
			for await (const row of parseForm499(MALFORMED_TSV)) {
				rows.push(row)
			}
		} catch {
			threw = true
		}

		expect(threw).toBe(true)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.form499ID).toBe("804981")
	})
})

describe("classifyFiler", () => {
	function baseRow(overrides: Partial<Form499Row>): Form499Row {
		return {
			form499ID: "1",
			frn: null,
			lastFiledAt: "2026-01-01",
			usfContributor: false,
			legalNameOfCarrier: "",
			doingBusinessAs: "",
			principalCommType: "",
			holdingCompany: "",
			managementCompany: "",
			hqAddress: "",
			customerInquiriesTelephone: "",
			customerInquiriesAddress: "",
			dcAgentDisplayName: "",
			dcAgentOrganizationName: "",
			dcAgentTelephone: "",
			dcAgentEmailAddress: "",
			dcAgentAddress: "",
			...overrides,
		}
	}

	it("classifies Incumbent LEC", () => {
		const row = baseRow({ principalCommType: "Incumbent Local Exchange Carrier" })
		expect(classifyFiler(row)).toEqual([FilerClassification.IncumbentLEC])
	})

	it("classifies CLEC", () => {
		const row = baseRow({ principalCommType: "Competitive Local Exchange Carrier (CLEC)" })
		expect(classifyFiler(row)).toEqual([FilerClassification.CLEC])
	})

	it("classifies Interexchange", () => {
		const row = baseRow({ principalCommType: "Interexchange Carrier" })
		expect(classifyFiler(row)).toEqual([FilerClassification.InterExchange])
	})

	it("classifies Toll Reseller", () => {
		const row = baseRow({ principalCommType: "Toll Reseller" })
		expect(classifyFiler(row)).toEqual([FilerClassification.TollReseller])
	})

	it("classifies USF contributor independently of principalCommType", () => {
		const row = baseRow({ usfContributor: true, principalCommType: "Interexchange Carrier" })
		const result = classifyFiler(row)

		expect(result).toHaveLength(2)

		expect(result).toEqual(
			expect.arrayContaining([FilerClassification.USFContributor, FilerClassification.InterExchange])
		)
	})

	it("does not double-classify Incumbent as also CLEC (ports the if/else-if from :164-176)", () => {
		const row = baseRow({ principalCommType: "Incumbent Local Exchange Carrier, CLEC-eligible" })
		expect(classifyFiler(row)).toEqual([FilerClassification.IncumbentLEC])
	})

	it("returns an empty array for an unrecognized principalCommType and no USF flag", () => {
		const row = baseRow({ principalCommType: "Unknown" })
		expect(classifyFiler(row)).toEqual([])
	})

	it("classifies Interexchange and Toll Reseller together when both substrings are present", () => {
		const row = baseRow({ principalCommType: "Interexchange Carrier and Toll Reseller" })
		const result = classifyFiler(row)

		expect(result).toEqual(
			expect.arrayContaining([FilerClassification.InterExchange, FilerClassification.TollReseller])
		)

		expect(result).toHaveLength(2)
	})
})
