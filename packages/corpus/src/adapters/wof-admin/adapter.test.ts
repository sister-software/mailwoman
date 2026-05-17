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
import { WOF_ADMIN_ADAPTER_ID, createWofAdminAdapter, variantsFor } from "./adapter.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtureSqlPath = resolve(here, "../../../fixtures/wof-admin/fixture.sql")

let scratch: string
let dbPath: string

async function buildFixtureDb(): Promise<string> {
	const sql = await readFile(fixtureSqlPath, "utf8")
	const path = join(scratch, "wof-admin-fixture.db")
	const db = new Database(path)
	db.exec(sql)
	db.close()
	return path
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-wof-admin-"))
	dbPath = await buildFixtureDb()
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("variantsFor (pure)", () => {
	const row = (over: Partial<{ id: number; name: string; placetype: string; country: string }>) => ({
		id: 1,
		parent_id: null,
		name: "X",
		placetype: "locality",
		country: "US",
		...over,
	})

	it("locality yields 3 variants when region + country are in ancestry", () => {
		const v = variantsFor(row({ name: "Portland" }), [
			row({ id: 10, name: "Oregon", placetype: "region" }),
			row({ id: 100, name: "United States", placetype: "country" }),
		])
		expect(v.map((x) => x.suffix)).toEqual(["self", "with-region", "with-region-country"])
		expect(v[2]!.components).toEqual({
			locality: "Portland",
			region: "Oregon",
			country: "United States of America",
		})
	})

	it("locality yields 2 variants when only country is in ancestry", () => {
		const v = variantsFor(row({ name: "Atlantis" }), [row({ id: 100, name: "United States", placetype: "country" })])
		expect(v.map((x) => x.suffix)).toEqual(["self", "with-country"])
	})

	it("region yields self + with-country", () => {
		const v = variantsFor(row({ name: "Oregon", placetype: "region" }), [
			row({ id: 100, name: "United States", placetype: "country" }),
		])
		expect(v.map((x) => x.suffix)).toEqual(["self", "with-country"])
	})

	it("country yields self only with canonical display name", () => {
		const v = variantsFor(row({ name: "United States", placetype: "country" }), [])
		expect(v).toHaveLength(1)
		expect(v[0]!.components).toEqual({ country: "United States of America" })
	})

	it("subregion (county) yields self only", () => {
		const v = variantsFor(row({ name: "Multnomah County", placetype: "county" }), [
			row({ id: 10, name: "Oregon", placetype: "region" }),
		])
		expect(v).toHaveLength(1)
		expect(v[0]!.components).toEqual({ subregion: "Multnomah County" })
	})
})

describe("wof-admin adapter against fixture", () => {
	it("emits a manifest with the expected row counts (US+FR fixture, no country filter)", async () => {
		const manifest = await runAdapter({
			adapter: createWofAdminAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})

		// Fixture has 12 spr rows; 1 superseded → 11 live.
		// Per row variant emission (locality:3 if region+country, region:2 if country, country:1, county:1):
		//   US country:                   1
		//   US region Oregon:              2
		//   US region Vermont:             2
		//   US county Multnomah:           1
		//   US locality Portland (OR):     3
		//   US locality Burlington (VT):   3
		//   FR country:                    1
		//   FR region Île-de-France:       2
		//   FR region Auvergne-Rhône-Alpes:2
		//   FR county Rhône:               1
		//   FR locality Paris:             3
		//   FR locality Lyon:              3
		// Total: 24
		expect(manifest.yielded).toBe(24)
		// canonicalDedupKey is per-row insensitive to country alone, so the "United States" /
		// "France" country-only rows survive; locality variants survive by suffix.
		expect(manifest.written).toBeGreaterThan(0)
		expect(manifest.written).toBeLessThanOrEqual(24)
		expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
	})

	it("country=FR filter cuts emission to FR rows only", async () => {
		const manifest = await runAdapter({
			adapter: createWofAdminAdapter(),
			adapterOptions: { inputPath: dbPath, country: "FR" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})

		const jsonl = await readFile(join(scratch, WOF_ADMIN_ADAPTER_ID, "canonical.jsonl"), "utf8")
		const rows = jsonl
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as CanonicalRow)
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.every((r) => r.country === "FR")).toBe(true)
		expect(rows.every((r) => r.source === WOF_ADMIN_ADAPTER_ID)).toBe(true)
		expect(rows.every((r) => r.license === "CC0-1.0")).toBe(true)
		expect(rows.every((r) => r.locale === "fr-FR")).toBe(true)
	})

	it("emits the expected canonical Paris hierarchies", async () => {
		const manifest = await runAdapter({
			adapter: createWofAdminAdapter(),
			adapterOptions: { inputPath: dbPath, country: "FR" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.written).toBeGreaterThan(0)

		const jsonl = await readFile(join(scratch, WOF_ADMIN_ADAPTER_ID, "canonical.jsonl"), "utf8")
		const raws = jsonl
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as CanonicalRow).raw)

		expect(raws).toContain("Paris")
		expect(raws).toContain("Paris, Île-de-France")
		// FR template ordering puts the country last; check substring presence
		const parisFull = raws.find((r) => r.includes("Paris") && r.includes("France") && r.includes("Île-de-France"))
		expect(parisFull).toBeDefined()
	})

	it("limit truncates total emission", async () => {
		const manifest = await runAdapter({
			adapter: createWofAdminAdapter(),
			adapterOptions: { inputPath: dbPath, limit: 3 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(3)
		expect(manifest.written).toBe(3)
	})

	it("excludes superseded (is_current=0) records", async () => {
		const manifest = await runAdapter({
			adapter: createWofAdminAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const jsonl = await readFile(join(scratch, WOF_ADMIN_ADAPTER_ID, "canonical.jsonl"), "utf8")
		expect(jsonl).not.toContain("Old Place")
		expect(manifest.yielded).toBe(24)
	})

	it("two runs over the same fixture produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createWofAdminAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, WOF_ADMIN_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createWofAdminAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
