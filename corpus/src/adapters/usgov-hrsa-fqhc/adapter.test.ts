/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { alignRow } from "../../align.js"
import { runAdapter } from "../../runner.js"
import type { CanonicalRow } from "../../types.js"
import { USGOV_HRSA_FQHC_ADAPTER_ID, USGOV_HRSA_FQHC_DEFAULT_LICENSE, createUsgovHrsaFqhcAdapter } from "./adapter.js"

const fixtureCSV = repoRootPath("corpus", "fixtures", "usgov-hrsa-fqhc", "sample.csv")

let scratch: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-usgov-hrsa-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

async function loadRows(): Promise<CanonicalRow[]> {
	const jsonl = await readFile(join(scratch, USGOV_HRSA_FQHC_ADAPTER_ID, "canonical.jsonl"), "utf8")
	const trimmed = jsonl.trim()

	if (!trimmed) return []

	return trimmed.split("\n").map((l) => JSON.parse(l) as CanonicalRow)
}

describe("usgov-hrsa-fqhc adapter against fixture sample.csv", () => {
	it("emits one row per valid CSV record + drops invalid ones", async () => {
		const m = await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		// 10 fixture rows minus 2 (empty Site Name on row 9, invalid state "ZZ" on row 10).
		expect(m.yielded).toBe(8)
		const rows = await loadRows()
		expect(rows).toHaveLength(8)
		expect(rows.every((r) => r.country === "US")).toBe(true)
		expect(rows.every((r) => r.locale === "en-US")).toBe(true)
		expect(rows.every((r) => r.license === USGOV_HRSA_FQHC_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === USGOV_HRSA_FQHC_ADAPTER_ID)).toBe(true)
	})

	it("source_id uses HRSA Site ID when present", async () => {
		await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-hrsa-fqhc-H80CS00001")
		expect(row).toBeDefined()
		expect(row!.components).toMatchObject({
			venue: "Buffalo Health Center Inc.",
			house_number: "123",
			street: "Main St",
			locality: "Buffalo",
			region: "NY",
			postcode: "14201",
		})
	})

	it("composes a venue-prefixed envelope-style raw line", async () => {
		await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-hrsa-fqhc-H80CS00001")!
		expect(row.raw).toBe("Buffalo Health Center Inc., 123 Main St, Buffalo, NY 14201")
	})

	it("kryptonite case: 'Buffalo Health Center' + 'Buffalo NY' aligns to disjoint spans (venue first)", async () => {
		await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-hrsa-fqhc-H80CS00001")!
		// Alignment downstream must place the venue's "Buffalo" under B-venue and the
		// locality's "Buffalo" under B-locality (not vice versa).
		const result = alignRow(row)
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return
		const buffaloIndices = result.row.tokens.map((t, i) => (t === "Buffalo" ? i : -1)).filter((i) => i >= 0)
		expect(buffaloIndices).toHaveLength(2)
		expect(result.row.labels[buffaloIndices[0]!]).toBe("B-venue")
		expect(result.row.labels[buffaloIndices[1]!]).toBe("B-locality")
	})

	it("preserves Suite designators on the street component (no separate unit slot)", async () => {
		await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-hrsa-fqhc-H80CS00002")!
		expect(row.components.street).toBe("SE Hawthorne Blvd Suite 200")
	})

	it("PO Box surface form preserved verbatim in street (no false house-number split)", async () => {
		await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-hrsa-fqhc-H80CS00007")!
		expect(row.components.house_number).toBeUndefined()
		expect(row.components.street).toBe("PO Box 1234")
	})

	it("hyphenated NYC-style house number splits cleanly", async () => {
		await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-hrsa-fqhc-H80CS00008")!
		expect(row.components.house_number).toBe("40-12")
		expect(row.components.street).toBe("Bell Blvd")
	})

	it("drops rows whose state is not a recognized USPS abbreviation", async () => {
		await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows.find((r) => r.source_id === "usgov-hrsa-fqhc-H80CS00010")).toBeUndefined()
	})

	it("drops rows missing a venue (empty Site Name)", async () => {
		await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows.find((r) => r.source_id === "usgov-hrsa-fqhc-H80CS00009")).toBeUndefined()
	})

	it("rejects non-US --country", async () => {
		await expect(
			runAdapter({
				adapter: createUsgovHrsaFqhcAdapter(),
				adapterOptions: { inputPath: fixtureCSV, country: "FR" },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/only US supported/)
	})

	it("honors --limit", async () => {
		const m = await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV, limit: 3 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(m.yielded).toBe(3)
		expect(m.written).toBe(3)
	})

	it("two runs against the same fixture produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, USGOV_HRSA_FQHC_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createUsgovHrsaFqhcAdapter(),
			adapterOptions: { inputPath: fixtureCSV },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
