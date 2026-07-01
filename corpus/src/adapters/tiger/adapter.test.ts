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
import { TIGER_ADAPTER_ID, TIGER_DEFAULT_LICENSE, createTigerAdapter } from "./adapter.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtureSQLPath = resolve(here, "../../../fixtures/tiger/fixture.sql")

let scratch: string
let dbPath: string

async function buildFixtureDB(): Promise<string> {
	const sql = await readFile(fixtureSQLPath, "utf8")
	const path = join(scratch, "tiger-fixture.db")
	const db = new DatabaseSync(path)
	db.exec(sql)
	db.close()

	return path
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-tiger-"))
	dbPath = await buildFixtureDB()
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

async function loadRows(): Promise<CanonicalRow[]> {
	const jsonl = await readFile(join(scratch, TIGER_ADAPTER_ID, "canonical.jsonl"), "utf8")
	const trimmed = jsonl.trim()

	if (!trimmed) return []

	return trimmed.split("\n").map((l) => JSON.parse(l) as CanonicalRow)
}

describe("tiger adapter against fixture.sql", () => {
	it("emits street rows + place variants and stamps US country + Public Domain license", async () => {
		const m = await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})

		// 7 streets × 1 variant each (zipl === zipr in every fixture row) = 7
		// + 4 places × 3 variants each = 12
		// Total: 19
		expect(m.yielded).toBe(19)
		const rows = await loadRows()
		expect(rows).toHaveLength(19)
		expect(rows.every((r) => r.country === "US")).toBe(true)
		expect(rows.every((r) => r.locale === "en-US")).toBe(true)
		expect(rows.every((r) => r.license === TIGER_DEFAULT_LICENSE)).toBe(true)
		expect(rows.every((r) => r.source === TIGER_ADAPTER_ID)).toBe(true)
	})

	it("street rows carry street + region + postcode and a US-idiomatic raw line", async () => {
		await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const salmon = rows.find((r) => r.source_id === "tiger-st-110000001-zip-97215")
		expect(salmon).toBeDefined()
		expect(salmon!.components).toMatchObject({
			street_prefix: "SE",
			street: "Salmon",
			street_suffix: "St",
			region: "OR",
			postcode: "97215",
		})
		expect(salmon!.raw).toContain("SE Salmon St")
		expect(salmon!.raw).toContain("OR")
		expect(salmon!.raw).toContain("97215")
	})

	it("emits 3 place variants per fixture place row (locality-only / with-region / with-region-country)", async () => {
		await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const portlandVariants = rows.filter((r) => r.source_id.startsWith("tiger-pl-4159000-"))
		expect(portlandVariants.map((r) => r.source_id).sort()).toEqual([
			"tiger-pl-4159000-locality-only",
			"tiger-pl-4159000-with-region",
			"tiger-pl-4159000-with-region-country",
		])

		const localityOnly = portlandVariants.find((r) => r.source_id.endsWith("-locality-only"))!
		expect(localityOnly.components.locality).toBe("Portland")
		expect(localityOnly.components.region).toBeUndefined()
		expect(localityOnly.components.country).toBeUndefined()

		const withRegion = portlandVariants.find((r) => r.source_id.endsWith("-with-region"))!
		expect(withRegion.components.region).toBe("OR")
		expect(withRegion.components.country).toBeUndefined()
	})

	it("with-region-country variant carries the canonical US country display name", async () => {
		await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const burlingtonFull = rows.find((r) => r.source_id === "tiger-pl-5010675-with-region-country")
		expect(burlingtonFull).toBeDefined()
		expect(burlingtonFull!.components.country).toBe("United States of America")
		expect(burlingtonFull!.raw).toContain("Burlington")
		expect(burlingtonFull!.raw).toContain("VT")
		expect(burlingtonFull!.raw).toContain("United States of America")
	})

	it("zipl !== zipr produces two street variants (one per side)", async () => {
		// Build a mini DB with one segment whose left and right ZIPs differ.
		const inline = join(scratch, "split-zip.db")
		const db = new DatabaseSync(inline)
		db.exec(`
			CREATE TABLE tiger_streets (linearid TEXT PRIMARY KEY, fullname TEXT NOT NULL, zipl TEXT, zipr TEXT, statefp TEXT NOT NULL);
			CREATE TABLE tiger_places (geoid TEXT PRIMARY KEY, name TEXT NOT NULL, statefp TEXT NOT NULL, lsad TEXT);
			INSERT INTO tiger_streets VALUES ('110099999', 'Border Rd', '10001', '10002', '36');
		`)
		db.close()

		await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: inline },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => r.source_id).sort()).toEqual([
			"tiger-st-110099999-zipl-10001",
			"tiger-st-110099999-zipr-10002",
		])
		expect(rows[0]!.components.postcode).toBe("10001")
		expect(rows[1]!.components.postcode).toBe("10002")
	})

	it("street with no ZIPs emits a single zipless variant", async () => {
		const inline = join(scratch, "no-zip.db")
		const db = new DatabaseSync(inline)
		db.exec(`
			CREATE TABLE tiger_streets (linearid TEXT PRIMARY KEY, fullname TEXT NOT NULL, zipl TEXT, zipr TEXT, statefp TEXT NOT NULL);
			CREATE TABLE tiger_places (geoid TEXT PRIMARY KEY, name TEXT NOT NULL, statefp TEXT NOT NULL, lsad TEXT);
			INSERT INTO tiger_streets VALUES ('110099998', 'Unnamed Rd', NULL, NULL, '41');
		`)
		db.close()

		await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: inline },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows).toHaveLength(1)
		expect(rows[0]!.source_id).toBe("tiger-st-110099998-no-zip")
		expect(rows[0]!.components.postcode).toBeUndefined()
		expect(rows[0]!.components.region).toBe("OR")
	})

	it("rows with an unrecognized state FIPS code are dropped", async () => {
		const inline = join(scratch, "bad-fips.db")
		const db = new DatabaseSync(inline)
		db.exec(`
			CREATE TABLE tiger_streets (linearid TEXT PRIMARY KEY, fullname TEXT NOT NULL, zipl TEXT, zipr TEXT, statefp TEXT NOT NULL);
			CREATE TABLE tiger_places (geoid TEXT PRIMARY KEY, name TEXT NOT NULL, statefp TEXT NOT NULL, lsad TEXT);
			INSERT INTO tiger_streets VALUES ('110099997', 'Phantom St', '00000', '00000', '99');
			INSERT INTO tiger_places  VALUES ('9999000', 'Phantomville', '99', '25');
		`)
		db.close()

		await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: inline },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows).toHaveLength(0)
	})

	it("rejects non-US --country", async () => {
		await expect(
			runAdapter({
				adapter: createTigerAdapter(),
				adapterOptions: { inputPath: dbPath, country: "FR" },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/only US supported/)
	})

	it("honors --limit across the combined street + place output", async () => {
		const m = await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: dbPath, limit: 5 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(m.yielded).toBe(5)
		expect(m.written).toBe(5)
	})

	it("two runs against the same fixture DB produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, TIGER_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createTigerAdapter(),
			adapterOptions: { inputPath: dbPath },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})
})
