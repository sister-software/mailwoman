/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runAdapter } from "../../runner.js"
import type { CanonicalRow } from "../../types.js"
import {
	FCC_BDC_ADAPTER_ID,
	FCC_BDC_DEFAULT_LICENSE,
	buildPostcode,
	createFccBdcAdapter,
	splitAddressPrimary,
} from "./adapter.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtureSqlPath = resolve(here, "../../../fixtures/fcc-bdc/fixture.sql")

let scratch: string
let dbPath: string

async function buildFixtureDb(): Promise<string> {
	const sql = await readFile(fixtureSqlPath, "utf8")
	const path = join(scratch, "fcc-bdc-fixture.db")
	const db = new DatabaseSync(path)
	db.exec(sql)
	db.close()
	return path
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-fcc-bdc-"))
	dbPath = await buildFixtureDb()
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

async function loadRows(): Promise<CanonicalRow[]> {
	const jsonl = await readFile(join(scratch, FCC_BDC_ADAPTER_ID, "canonical.jsonl"), "utf8")
	const trimmed = jsonl.trim()
	if (!trimmed) return []
	return trimmed.split("\n").map((l) => JSON.parse(l) as CanonicalRow)
}

describe("splitAddressPrimary", () => {
	it("splits a standard urban address into house_number + street", () => {
		expect(splitAddressPrimary("123 Main St")).toEqual({ house_number: "123", street: "Main St" })
	})

	it("preserves directional prefixes inside the street component", () => {
		expect(splitAddressPrimary("6450 W Indian School Rd")).toEqual({
			house_number: "6450",
			street: "W Indian School Rd",
		})
	})

	it("recognizes a single trailing letter on the house number", () => {
		expect(splitAddressPrimary("101A Main St")).toEqual({ house_number: "101A", street: "Main St" })
	})

	it("recognizes hyphenated house numbers (NYC garden-apartment style)", () => {
		expect(splitAddressPrimary("40-12 Bell Blvd")).toEqual({ house_number: "40-12", street: "Bell Blvd" })
	})

	it("returns street-only for shapes lacking a leading digit", () => {
		expect(splitAddressPrimary("PO Box 1234")).toEqual({ street: "PO Box 1234" })
		expect(splitAddressPrimary("RR 2 Box 67")).toEqual({ street: "RR 2 Box 67" })
	})

	it("returns null for empty or whitespace-only input", () => {
		expect(splitAddressPrimary("")).toBeNull()
		expect(splitAddressPrimary("   ")).toBeNull()
	})
})

describe("buildPostcode", () => {
	it("returns the bare zip when no suffix is present", () => {
		expect(buildPostcode("97215", null)).toBe("97215")
		expect(buildPostcode("97215", "")).toBe("97215")
		expect(buildPostcode("97215", "   ")).toBe("97215")
	})

	it("joins zip + 4-digit suffix with a hyphen", () => {
		expect(buildPostcode("97214", "1234")).toBe("97214-1234")
	})

	it("uses an already-joined suffix as-is", () => {
		expect(buildPostcode("97211", "97211-5678")).toBe("97211-5678")
	})

	it("returns empty when zip is missing", () => {
		expect(buildPostcode("", "1234")).toBe("")
	})
})

describe("fcc-bdc adapter against fixture.sql", () => {
	it("emits one row per recognized BSL location and stamps US + Public Domain", async () => {
		const m = await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		// 11 valid rows (1 dropped: ZZ state) — exact number depends on which fixture rows
		// the address-formatter renders into a non-empty `raw`. The strict equality below catches
		// any future drift in the format pipeline.
		expect(m.yielded).toBe(11)
		const rows = await loadRows()
		expect(rows).toHaveLength(11)
		expect(rows.every((r) => r.country === "US")).toBe(true)
		expect(rows.every((r) => r.locale === "en-US")).toBe(true)
		expect(rows.every((r) => r.license === FCC_BDC_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === FCC_BDC_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.source_id.startsWith("fcc-bdc-"))).toBe(true)
	})

	it("drops rows whose state column is not a valid US abbreviation", async () => {
		await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows.find((r) => r.source_id === "fcc-bdc-1000000099")).toBeUndefined()
	})

	it("splits address_primary into house_number + street", async () => {
		await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "fcc-bdc-1000000001")
		expect(row).toBeDefined()
		expect(row!.components).toMatchObject({
			house_number: "123",
			street: "Main St",
			locality: "Portland",
			region: "OR",
			postcode: "97215",
		})
		expect(row!.raw).toContain("123 Main St")
		expect(row!.raw).toContain("Portland")
		expect(row!.raw).toContain("OR")
		expect(row!.raw).toContain("97215")
	})

	it("joins zip + 4-digit zip_suffix into the postcode component", async () => {
		await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "fcc-bdc-1000000002")
		expect(row).toBeDefined()
		expect(row!.components.postcode).toBe("97214-1234")
		expect(row!.raw).toContain("97214-1234")
	})

	it("preserves an already-joined ZIP+4 surface form in zip_suffix", async () => {
		await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "fcc-bdc-1000000003")
		expect(row).toBeDefined()
		expect(row!.components.postcode).toBe("97211-5678")
	})

	it("PO Box entries keep the original surface form as street (no false house-number split)", async () => {
		await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const poBox = rows.find((r) => r.source_id === "fcc-bdc-1000000050")
		expect(poBox).toBeDefined()
		expect(poBox!.components.house_number).toBeUndefined()
		expect(poBox!.components.street).toBe("PO Box 1234")
		expect(poBox!.raw).toContain("PO Box 1234")
	})

	it("hyphenated house numbers split cleanly", async () => {
		await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "fcc-bdc-1000000020")
		expect(row).toBeDefined()
		expect(row!.components).toMatchObject({ house_number: "40-12", street: "Bell Blvd" })
	})

	it("emits territory rows (PR is a valid USPS abbreviation)", async () => {
		await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const row = rows.find((r) => r.source_id === "fcc-bdc-1000000060")
		expect(row).toBeDefined()
		expect(row!.components.region).toBe("PR")
	})

	it("rejects non-US --country", async () => {
		await expect(
			runAdapter({
				adapter: createFccBdcAdapter(),
				adapterOptions: { inputPath: dbPath, country: "FR" },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/only US supported/)
	})

	it("honors --limit", async () => {
		const m = await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath, limit: 3 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(m.yielded).toBe(3)
		expect(m.written).toBe(3)
	})

	it("two runs against the same fixture DB produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, FCC_BDC_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createFccBdcAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
