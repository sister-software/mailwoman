/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the decision-6 layer-absent guards. The guards live in their own module rather than
 *   in `cli.ts` precisely because these three functions are pure, transport-independent
 *   logic: nothing in them needs the stdio connection `cli.ts` opens at import time (the actual reason `cli.ts`
 *   itself can't be imported by vitest). Each guard gets its three branches exercised directly: path `undefined`,
 *   path set but the file missing, path set and the file present.
 */

import {
	assertBDCDatabaseExists,
	assertFilerDatabaseExists,
	openBDCDatabaseIfPresent,
	openFilerDatabaseIfPresent,
	openPlausibilityPOIDeps,
} from "@mailwoman/mcp/layer-guards"
import { mkdtemp, rm } from "@mailwoman/platform/fs/promises"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import {
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	type POIDatabase,
} from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, describe, expect, it } from "vitest"

let scratch: string | undefined

afterEach(async () => {
	if (scratch) {
		await rm(scratch, { recursive: true, force: true })
		scratch = undefined
	}
})

/**
 * A valid, empty sqlite file on disk (read-write open + immediate close). `openBDCDatabaseIfPresent` and
 * `assertBDCDatabaseExists` only ever re-open read-only and never query anything in these tests, so a schema-less empty
 * db is a faithful "file present" fixture for both.
 */
async function emptySqliteFile(name: string): Promise<string> {
	scratch = await mkdtemp(join(tmpdir(), "mcp-layer-guards-"))
	const path = join(scratch, name)

	new DatabaseClient<POIDatabase>(path).destroy()

	return path
}

/**
 * A minimal REAL poi.db — same fixture idiom as `bdc/sdk/nearest-infrastructure.test.ts`'s `buildPOIFixture`.
 * `POILookup`'s constructor eagerly prepares statements against `poi`/`poi_search` and queries `poi_category_codes`
 * (see `poi-lookup.ts`), so an arbitrary empty file won't do — `openPlausibilityPOIDeps`'s "file present" branch needs
 * these tables to actually exist.
 */
async function poiFixtureFile(name: string): Promise<string> {
	scratch = await mkdtemp(join(tmpdir(), "mcp-layer-guards-"))
	const path = join(scratch, name)
	await using kdb = new DatabaseClient<POIDatabase>(path)

	await createPOITable(kdb)
	// Also creates `poi_category_codes`, per `poi-schema.ts`'s naming.
	await createPOIStagingTables(kdb)
	createPOISearchFTS(kdb)

	return path
}

describe("openBDCDatabaseIfPresent", () => {
	it("returns undefined when databasePath is undefined", () => {
		expect(openBDCDatabaseIfPresent(undefined)).toBeUndefined()
	})

	it("returns undefined when the file is missing", () => {
		expect(openBDCDatabaseIfPresent("/nonexistent/path/bdc.db")).toBeUndefined()
	})

	it("opens the database when the file is present", async () => {
		const path = await emptySqliteFile("bdc.db")
		await using db = openBDCDatabaseIfPresent(path)

		expect(db).toBeDefined()
	})
})

describe("openPlausibilityPOIDeps", () => {
	it("returns undefined when databasePath is undefined", async () => {
		expect(await openPlausibilityPOIDeps(undefined)).toBeUndefined()
	})

	it("returns undefined when the file is missing", async () => {
		expect(await openPlausibilityPOIDeps("/nonexistent/path/poi.db")).toBeUndefined()
	})

	it("opens a lookup + contractDB pair sharing one handle when the file is present", async () => {
		const path = await poiFixtureFile("poi.db")
		const poi = await openPlausibilityPOIDeps(path)

		expect(poi).toBeDefined()
		expect(poi?.lookup).toBeDefined()
		expect(poi?.contractDB).toBeDefined()

		await poi?.contractDB.destroy()
	})
})

describe("assertBDCDatabaseExists", () => {
	it("throws a friendly error naming the layer when the file is missing", () => {
		expect(() => assertBDCDatabaseExists("mailwoman_bdc_filing_landscape", "/nonexistent/path/bdc.db")).toThrow(
			/mailwoman_bdc_filing_landscape: bdc\.db not found at "\/nonexistent\/path\/bdc\.db"/
		)
	})

	it("does not throw when the file is present", async () => {
		const path = await emptySqliteFile("bdc.db")

		expect(() => assertBDCDatabaseExists("mailwoman_bdc_filing_landscape", path)).not.toThrow()
	})
})

describe("openFilerDatabaseIfPresent", () => {
	it("returns undefined when databasePath is undefined", () => {
		expect(openFilerDatabaseIfPresent(undefined)).toBeUndefined()
	})

	it("returns undefined when the file is missing", () => {
		expect(openFilerDatabaseIfPresent("/nonexistent/path/filer.db")).toBeUndefined()
	})

	it("opens the database when the file is present", async () => {
		const path = await emptySqliteFile("filer.db")
		await using db = openFilerDatabaseIfPresent(path)

		expect(db).toBeDefined()
	})
})

describe("assertFilerDatabaseExists", () => {
	it("throws a friendly error naming the layer when the file is missing", () => {
		expect(() => assertFilerDatabaseExists("mailwoman_filer_lookup", "/nonexistent/path/filer.db")).toThrow(
			/mailwoman_filer_lookup: filer\.db not found at "\/nonexistent\/path\/filer\.db"/
		)
	})

	it("does not throw when the file is present", async () => {
		const path = await emptySqliteFile("filer.db")

		expect(() => assertFilerDatabaseExists("mailwoman_filer_lookup", path)).not.toThrow()
	})
})
