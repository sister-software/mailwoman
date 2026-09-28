/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The layer-absent guards are pure and transport-independent, which is why they live outside `cli.ts`,
 *   and each is exercised on its three branches: path `undefined`, path set but the file missing, and
 *   path set with the file present.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	assertBDCDatabaseExists,
	assertFilerDatabaseExists,
	openBDCDatabaseIfPresent,
	openFilerDatabaseIfPresent,
	openPlausibilityPOIDeps,
} from "@mailwoman/mcp/layer-guards"
import {
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	type POIDatabase,
} from "@mailwoman/resolver-wof-sqlite/poi"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterEach, describe, expect, it } from "vitest"

let scratch: TemporaryDirectory | undefined

afterEach(() => {
	scratch?.[Symbol.asyncDispose]()
	scratch = undefined
})

/**
 * A schema-less empty db is a faithful "file present" fixture for both callers because they only re-open
 * read-only and never query.
 */
async function emptySqliteFile(name: string): Promise<PathBuilder> {
	scratch = await temporaryDirectory("mcp-layer-guards-")
	const path = scratch.path(name)

	new DatabaseClient<POIDatabase>(path).destroy()

	return path
}

/**
 * `POILookup`'s constructor eagerly prepares statements against `poi`/`poi_search` and queries
 * `poi_category_codes`, so the "file present" branch needs these tables to actually exist.
 */
async function poiFixtureFile(name: string): Promise<PathBuilder> {
	scratch = await temporaryDirectory("mcp-layer-guards-")
	const path = scratch.path(name)
	using kdb = new DatabaseClient<POIDatabase>(path)

	await createPOITable(kdb)
	// Also creates `poi_category_codes`, per `poi-schema.ts`'s naming.
	await createPOIStagingTables(kdb)
	createPOISearchFTS(kdb)

	return path
}

describe("openBDCDatabaseIfPresent", () => {
	it("returns undefined when databasePath is undefined", async () => {
		expect(await openBDCDatabaseIfPresent(undefined)).toBeUndefined()
	})

	it("returns undefined when the file is missing", async () => {
		expect(await openBDCDatabaseIfPresent("/nonexistent/path/bdc.db")).toBeUndefined()
	})

	it("opens the database when the file is present", async () => {
		const path = await emptySqliteFile("bdc.db")
		using db = await openBDCDatabaseIfPresent(path)

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

	it("opens a lookup + schemadb pair sharing one handle when the file is present", async () => {
		const path = await poiFixtureFile("poi.db")
		const poi = await openPlausibilityPOIDeps(path)

		expect(poi).toBeDefined()
		expect(poi?.lookup).toBeDefined()
		expect(poi?.schemadb).toBeDefined()

		await poi?.schemadb.destroy()
	})
})

describe("assertBDCDatabaseExists", () => {
	it("throws a friendly error naming the layer when the file is missing", async () => {
		await expect(assertBDCDatabaseExists("mailwoman_bdc_filing_landscape", "/nonexistent/path/bdc.db")).rejects.toThrow(
			/mailwoman_bdc_filing_landscape: bdc\.db not found at "\/nonexistent\/path\/bdc\.db"/
		)
	})

	it("does not throw when the file is present", async () => {
		const path = await emptySqliteFile("bdc.db")

		await expect(assertBDCDatabaseExists("mailwoman_bdc_filing_landscape", path)).resolves.not.toThrow()
	})
})

describe("openFilerDatabaseIfPresent", () => {
	it("returns undefined when databasePath is undefined", async () => {
		expect(await openFilerDatabaseIfPresent(undefined)).toBeUndefined()
	})

	it("returns undefined when the file is missing", async () => {
		expect(await openFilerDatabaseIfPresent("/nonexistent/path/filer.db")).toBeUndefined()
	})

	it("opens the database when the file is present", async () => {
		const path = await emptySqliteFile("filer.db")
		using db = await openFilerDatabaseIfPresent(path)

		expect(db).toBeDefined()
	})
})

describe("assertFilerDatabaseExists", () => {
	it("throws a friendly error naming the layer when the file is missing", async () => {
		await expect(assertFilerDatabaseExists("mailwoman_filer_lookup", "/nonexistent/path/filer.db")).rejects.toThrow(
			/mailwoman_filer_lookup: filer\.db not found at "\/nonexistent\/path\/filer\.db"/
		)
	})

	it("does not throw when the file is present", async () => {
		const path = await emptySqliteFile("filer.db")

		await expect(assertFilerDatabaseExists("mailwoman_filer_lookup", path)).resolves.not.toThrow()
	})
})
