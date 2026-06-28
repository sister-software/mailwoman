/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { alignRow } from "../../align.js"
import { runAdapter } from "../../runner.js"
import type { CanonicalRow } from "../../types.js"
import {
	USGOV_SAMHSA_ADAPTER_ID,
	USGOV_SAMHSA_DEFAULT_LICENSE,
	createUsgovSamhsaTreatmentLocatorAdapter,
} from "./adapter.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtureCsv = resolve(here, "../../../fixtures/usgov-samhsa-treatment-locator/sample.csv")

let scratch: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-samhsa-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

async function loadRows(): Promise<CanonicalRow[]> {
	const jsonl = await readFile(join(scratch, USGOV_SAMHSA_ADAPTER_ID, "canonical.jsonl"), "utf8")
	const trimmed = jsonl.trim()

	if (!trimmed) return []

	return trimmed.split("\n").map((l) => JSON.parse(l) as CanonicalRow)
}

describe("usgov-samhsa-treatment-locator adapter against fixture sample.csv", () => {
	it("emits one row per valid CSV record + drops invalid ones", async () => {
		const m = await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		// 9 fixture rows minus 1 (invalid state "ZZ" on row SR0009).
		// SR0008 has empty name1 but non-empty name2, so composeVenue returns the parent org → still emitted.
		expect(m.yielded).toBe(8)
		const rows = await loadRows()
		expect(rows).toHaveLength(8)
		expect(rows.every((r) => r.country === "US")).toBe(true)
		expect(rows.every((r) => r.locale === "en-US")).toBe(true)
		expect(rows.every((r) => r.license === USGOV_SAMHSA_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === USGOV_SAMHSA_ADAPTER_ID)).toBe(true)
	})

	it("joins name1 + name2 with ' - ' when both are present", async () => {
		await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-samhsa-treatment-locator-SR0002")!
		expect(row.components.venue).toBe("Mountain Plains Counseling Services - Catholic Charities of Wyoming")
	})

	it("joins street1 + street2 with ', ' for two-line addresses", async () => {
		await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-samhsa-treatment-locator-SR0001")!
		expect(row.components.street).toBe("SW Madison St, Suite 300")
		expect(row.components.house_number).toBe("500")
	})

	it("preserves narrative sub-tenant designators verbatim in street", async () => {
		// "Suite C, behind main building" is the SAMHSA-specific adversarial training signal.
		await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-samhsa-treatment-locator-SR0003")!
		expect(row.components.street).toContain("Elmwood Ave")
		expect(row.components.street).toContain("Suite C")
		expect(row.components.street).toContain("behind main building")
	})

	it("kryptonite case: 'Buffalo Treatment Services' + 'Buffalo NY' aligns to disjoint spans", async () => {
		await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-samhsa-treatment-locator-SR0003")!
		const result = alignRow(row)
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return
		const buffaloIndices = result.row.tokens.map((t, i) => (t === "Buffalo" ? i : -1)).filter((i) => i >= 0)
		expect(buffaloIndices).toHaveLength(2)
		expect(result.row.labels[buffaloIndices[0]!]).toBe("B-venue")
		expect(result.row.labels[buffaloIndices[1]!]).toBe("B-locality")
	})

	it("hyphenated NYC-style house number splits cleanly", async () => {
		await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-samhsa-treatment-locator-SR0004")!
		expect(row.components.house_number).toBe("40-12")
		expect(row.components.street).toBe("Bell Blvd")
	})

	it("PO Box surface form preserved verbatim in street", async () => {
		await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-samhsa-treatment-locator-SR0007")!
		expect(row.components.house_number).toBeUndefined()
		expect(row.components.street).toBe("PO Box 5678")
	})

	it("uses name2 as fallback venue when name1 is empty", async () => {
		await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "usgov-samhsa-treatment-locator-SR0008")!
		expect(row.components.venue).toBe("Some Parent Org")
	})

	it("drops rows whose state is not a recognized USPS abbreviation", async () => {
		await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows.find((r) => r.source_id === "usgov-samhsa-treatment-locator-SR0009")).toBeUndefined()
	})

	it("rejects non-US --country", async () => {
		await expect(
			runAdapter({
				adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
				adapterOptions: { inputPath: fixtureCsv, country: "FR" },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/only US supported/)
	})

	it("honors --limit", async () => {
		const m = await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv, limit: 3 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(m.yielded).toBe(3)
		expect(m.written).toBe(3)
	})

	it("two runs against the same fixture produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, USGOV_SAMHSA_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createUsgovSamhsaTreatmentLocatorAdapter(),
			adapterOptions: { inputPath: fixtureCsv },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
