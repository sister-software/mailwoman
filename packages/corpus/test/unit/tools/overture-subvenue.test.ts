/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins the Overture sub-venue reader against a poi.db FIXTURE — a real SQLite file with the three
 *   tables the reader touches, built here rather than mocked.
 *
 *   The fixture is the point. `@mailwoman/corpus` declares poi.db's columns locally (it does not
 *   depend on `@mailwoman/resolver-wof-sqlite`, which owns the full `POIDatabase` interface), so
 *   nothing type-checks the projection against the real schema. What stands in for that is a fixture
 *   whose DDL matches the shipped layer's — `h3_cell`, `category_id`, `neg_rank`, `rowid_key` clustered
 *   PK, `name`, `country` — so a rename upstream fails here instead of throwing at runtime against a
 *   3.9 GB database no CI runner has.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	OVERTURE_SUBVENUE_CATEGORIES,
	readOvertureLayerVintage,
	readOvertureSubVenues,
} from "@mailwoman/corpus/tools/overture-subvenue"
import { sql } from "kysely"
import { afterAll, beforeAll, expect, test } from "vitest"

interface FixtureRow {
	category: string
	name: string | null
	country: string
}

/**
 * The deliberately small schema this fixture owns locally; see the file-level boundary note.
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
		 * Mirrors the shipped column so a rename fails here; it does NOT mirror the fold. The real `poi.name_key` is
		 * `NameKey`, minted by `normalizeLocalityForKey` — which this package cannot reach, and which no assertion here
		 * needs. Do not copy the value expression below as if it were the fold.
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
	// Deliberately present and NOT in the sub-venue set: the reader must not read it. `gas_station`
	// is the single largest designator-token producer in the whole layer (12,996 hits of `station`,
	// all inside brand names), so it is the right negative to pin.
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
	// Unnamed rows exist in the layer and carry nothing a lexicon can learn from.
	{ category: "airport_terminal", name: null, country: "US" },
]

let scratch: string
let databasePath: string

async function buildFixture(path: string): Promise<void> {
	const raw = new DatabaseSync(path)
	using kdb = new DatabaseClient<FixtureDatabase>({ database: raw })

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
	scratch = await mkdtemp(join(tmpdir(), "overture-subvenue-"))
	databasePath = join(scratch, "poi.db")

	await buildFixture(databasePath)
})

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true })
})

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

	// The negative that matters: `gas_station` is the layer's biggest source of the token `station`
	// and it must never reach the lexicon.
	expect(rows.some((row) => row.name === "Holiday Station")).toBe(false)
})

test("readOvertureSubVenues stamps the CONTEXT designator from the category, not from the name", async () => {
	const rows = await readOvertureSubVenues({ databasePath })
	const byName = new Map(rows.map((row) => [row.name, row]))

	// A campus building named "Cuddy Hall" is context `campus` — the row's category — even though the
	// phrase inside the name names `hall`. Attribution by phrase is the lexicon builder's job.
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
	// The wave-2 claim under test: the harvest row shape is source-neutral. `designatorID` and `name`
	// are all the builder needs; `ref` and `localizedNames` are optional and Overture has neither.
	const [row] = await readOvertureSubVenues({ databasePath, countries: ["CA"] })

	expect(row).toBeDefined()
	expect(typeof row!.designatorID).toBe("string")
	expect(typeof row!.name).toBe("string")
	expect(row).not.toHaveProperty("ref")
	expect(row).not.toHaveProperty("localizedNames")
})

test("readOvertureLayerVintage reads the layer-contract manifest", async () => {
	await expect(readOvertureLayerVintage(databasePath)).resolves.toBe("2026-05-20.0")
})

test("OVERTURE_SUBVENUE_CATEGORIES maps every category to a designator the lexicon knows", () => {
	// `pier` is a wave-2 addition to PROPOSED_DESIGNATORS; the rest predate it. A category mapped to a
	// designator with no record would produce surfaces pointing at nothing.
	expect(Object.entries(OVERTURE_SUBVENUE_CATEGORIES).toSorted()).toEqual([
		["airport_lounge", "terminal"],
		["airport_terminal", "terminal"],
		["campus_building", "campus"],
		["pier", "pier"],
	])
})
