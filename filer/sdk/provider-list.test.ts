/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode parseProviderList} — the BDC provider-list streaming CSV parser that
 *   preserves multi-FRN / multi-holding-company cardinality (3a Task 3, decision 6). The load-bearing
 *   assertions here are the two "yields EVERY row" tests: nothing in this file may collapse two rows
 *   sharing a `provider_id` into one, no matter how tempting a `Map` keyed by `provider_id` looks.
 */

import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { parseProviderList, type ProviderListRow } from "./provider-list.ts"

const FIXTURES_DIR = join(import.meta.dirname, "..", "test-fixtures")
const SAMPLE_CSV = join(FIXTURES_DIR, "provider-list-sample.csv")
const MALFORMED_CSV = join(FIXTURES_DIR, "provider-list-malformed.csv")
const MISSING_COLUMN_CSV = join(FIXTURES_DIR, "provider-list-missing-column.csv")
const BAD_FRN_CSV = join(FIXTURES_DIR, "provider-list-bad-frn.csv")
const BAD_PROVIDER_ID_CSV = join(FIXTURES_DIR, "provider-list-bad-provider-id.csv")

async function collect(csvPath: string): Promise<ProviderListRow[]> {
	const rows: ProviderListRow[] = []

	for await (const row of parseProviderList(csvPath)) {
		rows.push(row)
	}

	return rows
}

describe("parseProviderList", () => {
	it("parses a 5-row fixture into 5 typed rows", async () => {
		const rows = await collect(SAMPLE_CSV)

		expect(rows).toHaveLength(5)
	})

	it("yields EVERY row for a provider_id appearing with two different FRNs — no dedup, no last-wins (decision 6)", async () => {
		const rows = await collect(SAMPLE_CSV)
		const providerRows = rows.filter((row) => row.providerID === 130_077)

		expect(providerRows).toHaveLength(2)
		expect(providerRows.map((row) => row.frn)).toEqual(["0001753557", "0009999999"])
	})

	it("yields EVERY row for a provider_id appearing with two different holding-company strings — no dedup, no last-wins (decision 6)", async () => {
		const rows = await collect(SAMPLE_CSV)
		const providerRows = rows.filter((row) => row.providerID === 140_088)

		expect(providerRows).toHaveLength(2)

		expect(providerRows.map((row) => row.holdingCompany)).toEqual([
			"Second Holdings LLC",
			"Second Holdings, Renamed LLC",
		])
	})

	it("does not fold the two 140088 rows into one — both survive as separate yielded rows sharing one FRN", async () => {
		const rows = await collect(SAMPLE_CSV)
		const providerRows = rows.filter((row) => row.providerID === 140_088)

		expect(providerRows).toHaveLength(2)
		expect(providerRows[0]!.frn).toBe(providerRows[1]!.frn)
		expect(providerRows[0]!.holdingCompany).not.toBe(providerRows[1]!.holdingCompany)
	})

	it("zero-pads an unpadded FRN via toFRN, same as any other FRN source", async () => {
		const rows = await collect(SAMPLE_CSV)
		const row = rows.find((candidate) => candidate.providerID === 150_099)

		expect(row?.frn).toBe("0003456789")
	})

	it("converts an empty holding_company field to null rather than an empty string", async () => {
		const rows = await collect(SAMPLE_CSV)
		const row = rows.find((candidate) => candidate.providerID === 150_099)

		expect(row?.holdingCompany).toBeNull()
	})

	it("handles a quoted holding_company field containing a comma", async () => {
		const rows = await collect(SAMPLE_CSV)
		const row = rows.find((candidate) => candidate.holdingCompany === "Second Holdings, Renamed LLC")

		expect(row).toBeDefined()
		expect(row?.providerID).toBe(140_088)
	})

	it("throws a descriptive error naming the file and line number for a short row", async () => {
		let caught: unknown

		try {
			await collect(MALFORMED_CSV)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain(MALFORMED_CSV)
		expect((caught as Error).message).toMatch(/line 3|:3\b/)
	})

	it("never yields a row from the malformed file before the throw — the first (valid) row is fine, but the second must reject", async () => {
		const rows: ProviderListRow[] = []
		let threw = false

		try {
			for await (const row of parseProviderList(MALFORMED_CSV)) {
				rows.push(row)
			}
		} catch {
			threw = true
		}

		expect(threw).toBe(true)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.providerID).toBe(130_077)
	})

	it("throws naming the missing required column when the header omits holding_company", async () => {
		let caught: unknown

		try {
			await collect(MISSING_COLUMN_CSV)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain(MISSING_COLUMN_CSV)
		expect((caught as Error).message).toContain("holding_company")
	})

	it("throws naming the file and value for a row whose frn does not parse via toFRN", async () => {
		let caught: unknown

		try {
			await collect(BAD_FRN_CSV)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain(BAD_FRN_CSV)
		expect((caught as Error).message).toContain("frn")
		expect((caught as Error).message).toContain("not-an-frn")
	})

	it("throws a TypeError naming the file and value for a row whose provider_id does not parse to a safe integer", async () => {
		let caught: unknown

		try {
			await collect(BAD_PROVIDER_ID_CSV)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(TypeError)
		expect((caught as Error).message).toContain(BAD_PROVIDER_ID_CSV)
		expect((caught as Error).message).toContain("provider_id")
		expect((caught as Error).message).toContain("not-a-number")
	})
})
