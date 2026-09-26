/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Pin the Overture sub-venue reader against a real SQLite poi.db fixture whose DDL matches the shipped
 * layer's, because no type checker covers the projection against the real schema.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	OVERTURE_SUBVENUE_CATEGORIES,
	readOvertureLayerVintage,
	readOvertureSubVenues,
} from "@mailwoman/corpus/tools/overture-subvenue"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, expect, test } from "vitest"

interface FixtureRow {
	category: string
	name: string | null
	country: string
}

/**
 * The deliberately small schema this fixture owns locally.
 */
interface FixtureDatabase {
	poi_category_codes: {
		id: number
		category: string
	}
	layer_manifest: {
		name: string
		source_vintage: string
	}
	poi: {
		h3_cell: number
		category_id: number
		neg_rank: number
		rowid_key: number
		name: string | null
		/**
		 * Mirrors the shipped column so a rename fails here, but not the fold:
		 * the real `poi.name_key` is minted by `normalizeLocalityForKey`, and the value
		 * expression below must not be copied as if it were.
		 */
		name_key: string | null
		brand_wikidata: string | null
		latitude: number
		longitude: number
		country: string
		confidence: number
		gers_id: string | null
	}
}

const CATEGORY_IDS: Record<string, number> = {
	airport_terminal: 802,
	campus_building: 733,
	pier: 952,
	airport_lounge: 956,
	// Deliberately present and not in the sub-venue set, because `gas_station` is the
	// largest designator-token producer in the layer and so the right negative to pin.
	gas_station: 250,
}

const ROWS: FixtureRow[] = [
	{ category: "airport_terminal", name: "North Terminal", country: "US" },
	{ category: "airport_terminal", name: "Concourse B", country: "US" },
	{ category: "airport_terminal", name: "Terminal 1", country: "CA" },
	{ category: "campus_building", name: "Cuddy Hall", country: "US" },
	{ category: "pier", name: "Pier 39", country: "US" },
	{ category: "airport_lounge", name: "Delta Sky Club Concourse A", country: "US" },
	{ category: "gas_station", name: "Holiday Station", country: "US" },
	// Unnamed rows exist in the layer and carry no name a lexicon can learn from.
	{ category: "airport_terminal", name: null, country: "US" },
]

let scratch: TemporaryDirectory
let databasePath: PathBuilder

async function buildFixture(path: PathBuilder): Promise<void> {
	using kdb = new DatabaseClient<FixtureDatabase>(path)

	await kdb.schema
		.createTable("poi_category_codes")
		.addColumn("id", "integer", (col) => col.primaryKey())
		.addColumn("category", "text", (col) => col.unique())
		.execute()

	await kdb.schema
		.createTable("poi")
		.addColumn("h3_cell", "integer", (col) => col.notNull())
		.addColumn("category_id", "integer", (col) => col.notNull())
		.addColumn("neg_rank", "real", (col) => col.notNull())
		.addColumn("rowid_key", "integer", (col) => col.notNull())
		.addColumn("name", "text")
		.addColumn("name_key", "text")
		.addColumn("brand_wikidata", "text")
		.addColumn("latitude", "real", (col) => col.notNull())
		.addColumn("longitude", "real", (col) => col.notNull())
		.addColumn("country", "text", (col) => col.notNull())
		.addColumn("confidence", "real", (col) => col.notNull())
		.addColumn("gers_id", "text")
		.addPrimaryKeyConstraint("poi_pk", ["h3_cell", "category_id", "neg_rank", "rowid_key"])
		.modifyEnd(sql`without rowid`)
		.execute()

	await kdb.schema
		.createTable("layer_manifest")
		.addColumn("name", "text", (col) => col.primaryKey())
		.addColumn("source_vintage", "text", (col) => col.notNull())
		.execute()

	for (const [category, id] of Object.entries(CATEGORY_IDS)) {
		await kdb.insertInto("poi_category_codes").values({ id, category }).execute()
	}

	await kdb.insertInto("layer_manifest").values({ name: "poi", source_vintage: "2026-05-20.0" }).execute()

	let rowidKey = 1

	for (const row of ROWS) {
		await kdb
			.insertInto("poi")
			.values({
				h3_cell: 1000 + rowidKey,
				category_id: CATEGORY_IDS[row.category]!,
				neg_rank: 0.1,
				rowid_key: rowidKey++,
				name: row.name,
				name_key: row.name?.toLowerCase() ?? null,
				brand_wikidata: null,
				latitude: 61.2,
				longitude: -149.9,
				country: row.country,
				confidence: 0.9,
				gers_id: null,
			})
			.execute()
	}
}

beforeAll(async () => {
	scratch = await temporaryDirectory("overture-subvenue-")
	databasePath = scratch.path("poi.db")

	await buildFixture(databasePath)
})

afterAll(() => scratch[Symbol.asyncDispose]())

test("readOvertureSubVenues reads only the sub-venue categories, and only named rows", async () => {
	const rows = await readOvertureSubVenues({ databasePath })

	expect(rows.map((row) => row.name).toSorted()).toEqual([
		"Concourse B",
		"Cuddy Hall",
		"Delta Sky Club Concourse A",
		"North Terminal",
		"Pier 39",
		"Terminal 1",
	])

	// The negative that matters: `gas_station` is the layer's biggest source of the
	// token `station` and must never reach the lexicon.
	expect(rows.some((row) => row.name === "Holiday Station")).toBe(false)
})

test("readOvertureSubVenues stamps the CONTEXT designator from the category, not from the name", async () => {
	const rows = await readOvertureSubVenues({ databasePath })
	const byName = new Map(rows.map((row) => [row.name, row]))

	// A campus building named "Cuddy Hall" is context `campus` — the row's category — even though
	// the phrase inside the name names `hall`; attribution by phrase is the lexicon builder's job.
	expect(byName.get("Cuddy Hall")?.designatorID).toBe("campus")
	expect(byName.get("North Terminal")?.designatorID).toBe("terminal")
	expect(byName.get("Pier 39")?.designatorID).toBe("pier")
	expect(byName.get("Delta Sky Club Concourse A")?.designatorID).toBe("terminal")
})

test("readOvertureSubVenues carries the country, which is the axis promotion is decided on", async () => {
	const rows = await readOvertureSubVenues({ databasePath })

	expect(rows.find((row) => row.name === "Terminal 1")?.country).toBe("CA")
	expect(rows.find((row) => row.name === "North Terminal")?.country).toBe("US")
})

test("readOvertureSubVenues filters by country when asked", async () => {
	const rows = await readOvertureSubVenues({ databasePath, countries: ["CA"] })

	expect(rows.map((row) => row.name)).toEqual(["Terminal 1"])
})

test("a row from the reader satisfies SubVenueHarvestRow with no adaptation", async () => {
	// The harvest row shape is source-neutral: `designatorID` and `name` are all the
	// builder needs, and `ref` and `localizedNames` are optional.
	const [row] = await readOvertureSubVenues({ databasePath, countries: ["CA"] })

	expect(row).toBeDefined()
	expect(typeof row!.designatorID).toBe("string")
	expect(typeof row!.name).toBe("string")
	expect(row).not.toHaveProperty("ref")
	expect(row).not.toHaveProperty("localizedNames")
})

test("readOvertureLayerVintage reads the layer-interface manifest", async () => {
	await expect(readOvertureLayerVintage(databasePath)).resolves.toBe("2026-05-20.0")
})

test("OVERTURE_SUBVENUE_CATEGORIES maps every category to a designator the lexicon knows", () => {
	// A category mapped to a designator with no record would produce surfaces pointing at no record.
	expect(Object.entries(OVERTURE_SUBVENUE_CATEGORIES).toSorted()).toEqual([
		["airport_lounge", "terminal"],
		["airport_terminal", "terminal"],
		["campus_building", "campus"],
		["pier", "pier"],
	])
})
