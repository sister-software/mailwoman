/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import Database from "better-sqlite3"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runAdapter } from "../../runner.js"
import type { CanonicalRow } from "../../types.js"
import { WOF_POSTALCODE_ADAPTER_ID, createWofPostalcodeAdapter, postcodeVariantsFor } from "./adapter.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtureSqlPath = resolve(here, "../../../fixtures/wof-postalcode/fixture.sql")

let scratch: string
let dbPath: string

async function buildFixtureDb(): Promise<string> {
	const sql = await readFile(fixtureSqlPath, "utf8")
	const path = join(scratch, "wof-postalcode-fixture.db")
	const db = new Database(path)
	db.exec(sql)
	db.close()
	return path
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-wof-postalcode-"))
	dbPath = await buildFixtureDb()
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("postcodeVariantsFor (pure)", () => {
	const row = (over: Partial<{ id: number; name: string; placetype: string; country: string }>) => ({
		id: 1,
		parent_id: null,
		name: "X",
		placetype: "postalcode",
		country: "US",
		...over,
	})

	it("postcode with full ancestry yields 4 variants", () => {
		const v = postcodeVariantsFor(row({ name: "97214" }), [
			row({ id: 10, name: "Portland", placetype: "locality" }),
			row({ id: 20, name: "Oregon", placetype: "region" }),
			row({ id: 30, name: "United States", placetype: "country" }),
		])
		expect(v.map((x) => x.suffix)).toEqual([
			"self",
			"with-locality",
			"with-locality-region",
			"with-locality-region-country",
		])
		expect(v[3]!.components).toEqual({
			postcode: "97214",
			locality: "Portland",
			region: "Oregon",
			country: "United States of America",
		})
	})

	it("postcode without locality yields self only", () => {
		const v = postcodeVariantsFor(row({ name: "12345" }), [])
		expect(v).toHaveLength(1)
		expect(v[0]!.components).toEqual({ postcode: "12345" })
	})

	it("postcode with locality + region but no country yields 3 variants", () => {
		const v = postcodeVariantsFor(row({ name: "97214" }), [
			row({ id: 10, name: "Portland", placetype: "locality" }),
			row({ id: 20, name: "Oregon", placetype: "region" }),
		])
		expect(v.map((x) => x.suffix)).toEqual(["self", "with-locality", "with-locality-region"])
	})

	it("skips non-postcode placetypes", () => {
		const v = postcodeVariantsFor(row({ placetype: "locality" }), [])
		expect(v).toEqual([])
	})
})

describe("wof-postalcode adapter against fixture", () => {
	it("emits the right shape for FR postcodes (FR template: postcode before city)", async () => {
		const manifest = await runAdapter({
			adapter: createWofPostalcodeAdapter(),
			adapterOptions: { inputPath: dbPath, country: "FR" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.written).toBeGreaterThan(0)

		const jsonl = await readFile(join(scratch, WOF_POSTALCODE_ADAPTER_ID, "canonical.jsonl"), "utf8")
		const rows = jsonl
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as CanonicalRow)

		// FR template drops the region (encoded in the postcode) and emits "75008 Paris, France".
		// Reconciliation removes region from components when it isn't present in raw.
		const parisFull = rows.find(
			(r) => r.components.postcode === "75008" && r.components.locality === "Paris" && r.components.country === "France"
		)
		expect(parisFull).toBeDefined()
		expect(parisFull!.raw).toMatch(/75008\s+Paris/)
		expect(parisFull!.raw).toContain("France")
		expect(parisFull!.components.region).toBeUndefined()
		expect(rows.every((r) => r.source === WOF_POSTALCODE_ADAPTER_ID)).toBe(true)
	})

	it("emits the right shape for US postcodes (US template abbreviates state to alpha-2)", async () => {
		await runAdapter({
			adapter: createWofPostalcodeAdapter(),
			adapterOptions: { inputPath: dbPath, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const jsonl = await readFile(join(scratch, WOF_POSTALCODE_ADAPTER_ID, "canonical.jsonl"), "utf8")
		const rows = jsonl
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as CanonicalRow)

		// US template abbreviates "Oregon" to "OR"; reconciliation drops region from
		// components because "Oregon" does not occur verbatim in raw. (State-abbrev expansion
		// is a synthesis-step augmentation, not an alignment-step concern.) The variant that
		// originated from `with-locality-region` is still emitted, just with region scrubbed.
		const portlandOR = rows.find((r) => /Portland,\s+OR\s+97214/.test(r.raw))
		expect(portlandOR).toBeDefined()
		expect(portlandOR!.components.region).toBeUndefined()
		expect(portlandOR!.components.postcode).toBe("97214")
		expect(portlandOR!.components.locality).toBe("Portland")
	})

	it("excludes superseded postcodes", async () => {
		await runAdapter({
			adapter: createWofPostalcodeAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const jsonl = await readFile(join(scratch, WOF_POSTALCODE_ADAPTER_ID, "canonical.jsonl"), "utf8")
		expect(jsonl).not.toContain("00000")
	})

	it("two runs over the same fixture produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createWofPostalcodeAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, WOF_POSTALCODE_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createWofPostalcodeAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
