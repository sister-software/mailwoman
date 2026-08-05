/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Overture Places source for the sub-venue lexicon (#35 wave 2) — read the sub-venue-bearing
 *   category slices of `poi.db` (spatial layer #1, `$MAILWOMAN_DATA_ROOT/poi/poi.db`) and yield
 *   {@link SubVenueHarvestRow}s the lexicon builder consumes exactly like an OSM extract.
 *
 *   ── WHY OVERTURE AT ALL, when the OSM extractor already exists ────────────────────────────────────
 *   Wave 1 measured `concourse` at 21 real Overture rows against 4 in the whole Great Britain OSM
 *   extract, 3 of which are a street called CONCOURSE WAY. Overture's `airport_terminal` category is
 *   curated venue-interior naming; OSM's `aeroway=terminal` is a building footprint that usually
 *   carries the AIRPORT's name. The two sources fail differently, so both are read.
 *
 *   ── THE CATEGORY SET IS MEASURED, NOT GUESSED ────────────────────────────────────────────────────
 *   A full scan of all 13,681,698 rows (2026-08-05, poi.db vintage 2026-05-20.0) counted, per
 *   category, how many named rows carry a designator token. The ranking is NOT what a category name
 *   predicts — `gas_station` leads the whole table with 12,996 hits, every one of them the token
 *   `station` inside "Holiday Station" / "Chevron Station Seward", and `shoe_store` contributes 708
 *   hits of `wing` because Red Wing sells boots. {@link OVERTURE_SUBVENUE_CATEGORIES} is the four
 *   categories whose hits survived reading the distribution; the rejects are listed below it so nobody
 *   re-proposes them.
 *
 *   ── poi.db IS FOUR COUNTRIES ─────────────────────────────────────────────────────────────────────
 *   Measured the same day: US 11,521,612 / CA 794,418 / FR 721,352 / MX 644,316, and nothing else. The
 *   shipped layer is not a world gazetteer, so Overture can attest en-US, en-CA, fr-FR and es-MX
 *   surfaces and NOTHING ELSE. Every non-Latin designator the corpus task asks for — `ターミナル`,
 *   `Halle`, `Flügel` — has to come from the OSM leg. Do not read a zero count here as evidence of
 *   absence in the world; it is evidence of absence in four countries.
 *
 *   ── The row shape fits; the PROVENANCE STAMP did not ─────────────────────────────────────────────
 *   Wave 1's `OSMSubVenueRow` was written to accept a non-OSM row, and it does: an Overture row is
 *   `{ designatorID, name }` with no `ref` and no `localizedNames`. What did NOT fit is
 *   `extractAttestedPhrases`, which hardcoded `osm:name` as the surface's `source`. Feeding Overture
 *   rows through it unchanged would have labelled every Overture surface as OSM-attested — a
 *   provenance lie, and under ODbL a consequential one. Hence the `source`/`region` options on that
 *   function and the source-neutral {@link SubVenueHarvestRow} name.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

import type { SubVenueHarvestRow } from "./sub-venue-lexicon.ts"

/**
 * Overture Places category → the designator its rows attest.
 *
 * Each entry carries the 2026-08-05 full-scan measurement in a comment: `rows` is the category's total, `hits` is how
 * many of its named rows contain any designator token, and the token list is the top of that distribution.
 *
 * REJECTED, with the number that rejected them — do not re-add without a fresh census:
 *
 * - `gas_station` (12,996 hits) — all `station` inside a brand name (Holiday Station, Chevron Station Seward).
 * - `fire_station` (10,377) — same, plus 330 `hall` from fire halls, which are venues rather than sub-venues.
 * - `town_hall` (5,528) — `City Hall` is a whole building, the `venue` tier, not interior structure.
 * - `building_supply_store` (4,030) — `building` inside "Allied Building Products".
 * - `jehovahs_witness_place_of_worship` (2,334) — every hit is "Kingdom Hall of Jehovah's Witnesses".
 * - `shoe_store` (909, of which 708 `wing`) — Red Wing. This one is a CONFOUND BOARD entry, not a source.
 * - `college_university` (3,697) — 2,082 `campus`, but the row names the whole institution; `campus_building` is the
 *   interior slice and is kept instead.
 * - `airport` (6,000 rows, 4,302 hits) — 4,071 of them are the token `airport` in the aerodrome's own name. Venue tier,
 *   already covered by OurAirports, and it drowns the interior signal.
 * - `transport_interchange` (1 row), `rail_facility_or_service` (81 rows, 2 hits) — too small to matter.
 * - `public_transit_facility_or_service` (2,274 rows, 185 hits) — 161 are `station` naming the station itself.
 */
export const OVERTURE_SUBVENUE_CATEGORIES: Readonly<Record<string, string>> = {
	// 1,022 rows / 669 hits — terminal 266, concourse 19, gate 13, hall 4. The densest interior naming
	// in the layer and the reason this reader exists.
	airport_terminal: "terminal",
	// 7,366 rows / 3,382 hits — hall 2,134, building 1,019, campus 209. US academic halls and numbered
	// campus buildings: "UAA Cuddy Hall", "UAA Science Building". The row is a building ON a campus, so
	// `campus` is its CONTEXT designator; the phrase found inside the name decides the record it
	// attests, which for these rows is mostly `hall`.
	campus_building: "campus",
	// 443 rows / 301 hits — pier 282, terminal 17.
	pier: "pier",
	// 388 rows / 66 hits — airport 36, terminal 20, concourse 5, gate 3. Small, but the hits are almost
	// all genuine ("Delta Sky Club Concourse B").
	airport_lounge: "terminal",
}

/**
 * The `poi` and `poi_category_codes` columns this reader touches, declared LOCALLY.
 *
 * `@mailwoman/resolver-wof-sqlite` owns the full `POIDatabase` interface, and `@mailwoman/corpus` does not depend on it
 * — the same dependency-direction call `sub-venue-lexicon.ts` makes for `@mailwoman/osm`'s row type. This is a
 * read-only projection of four columns; `overture-subvenue.test.ts` builds a fixture with exactly this DDL, so a column
 * rename upstream fails a test here rather than throwing at runtime against a 3.9 GB database nobody has in CI.
 */
interface POIReadDatabase {
	poi: {
		category_id: number
		name: string | null
		country: string
	}
	poi_category_codes: {
		id: number
		category: string
	}
	layer_manifest: {
		name: string
		source_vintage: string
	}
}

/**
 * The layer's `source_vintage` — the Overture release the rows came from (`2026-05-20.0`), for the lexicon's
 * `sources[]`.
 *
 * Read off the database rather than passed in, because a vintage a caller types is a vintage that goes stale silently.
 * The layer-contract tables are part of every layer database by construction — see `docs/engineering/reference/
 * layer-contract.mdx` — so there is no version of poi.db where this is absent.
 */
export async function readOvertureLayerVintage(databasePath: string): Promise<string> {
	using kdb = new DatabaseClient<POIReadDatabase>({
		database: new DatabaseSync(databasePath, { readOnly: true }),
	})

	const row = await kdb
		.selectFrom("layer_manifest")
		.select("source_vintage")
		.where("name", "=", "poi")
		.executeTakeFirst()

	return row?.source_vintage ?? ""
}

export interface ReadOvertureSubVenuesOptions {
	/**
	 * Path to `poi.db`. Typically `dataRootPath("poi", "poi.db")`.
	 */
	databasePath: string
	/**
	 * Category → designator map. Defaults to {@link OVERTURE_SUBVENUE_CATEGORIES}.
	 */
	categories?: Readonly<Record<string, string>>
	/**
	 * Restrict to these ISO 3166-1 alpha-2 countries. Omit for all four the layer carries.
	 */
	countries?: readonly string[]
}

/**
 * One Overture row plus the country it came from — {@link SubVenueHarvestRow} widened by the field the layer has and an
 * OSM extract does not (a Geofabrik extract's country is a property of the invocation, so OSM rows carry `country:
 * ""`).
 */
export interface OvertureSubVenueRow extends SubVenueHarvestRow {
	/**
	 * ISO 3166-1 alpha-2, straight off the Overture partition.
	 */
	country: string
	/**
	 * The Overture category the row was read from, so a surface's provenance survives past the designator.
	 */
	category: string
}

/**
 * Read the sub-venue-bearing category slices of `poi.db`.
 *
 * Cold path, already async, no interface constraint — so Kysely, per the repo's inline-SQL rule.
 *
 * `category_id` is the SECOND component of poi.db's clustered `(h3_cell, category_id, …)` primary key, which reads like
 * a full 13.7M-row scan and is not one: SQLite skip-scans the leading `h3_cell` and the whole four-category read
 * returned 9,219 rows in **1.4 s** on the shipped layer (2026-08-05). A JS-side scan of every row to survey the same
 * question took 52 s, which is the number to remember if you are tempted to filter in JS instead.
 */
export async function readOvertureSubVenues(options: ReadOvertureSubVenuesOptions): Promise<OvertureSubVenueRow[]> {
	const categories = options.categories ?? OVERTURE_SUBVENUE_CATEGORIES

	using kdb = new DatabaseClient<POIReadDatabase>({
		database: new DatabaseSync(options.databasePath, { readOnly: true }),
	})

	const codes = await kdb
		.selectFrom("poi_category_codes")
		.select(["id", "category"])
		.where("category", "in", Object.keys(categories))
		.execute()

	if (!codes.length) return []

	const designatorByID = new Map<number, string>()
	const categoryByID = new Map<number, string>()

	for (const code of codes) {
		const designator = categories[code.category]

		if (!designator) continue
		designatorByID.set(code.id, designator)
		categoryByID.set(code.id, code.category)
	}

	let query = kdb
		.selectFrom("poi")
		.select(["category_id", "name", "country"])
		.where("category_id", "in", [...designatorByID.keys()])
		.where("name", "is not", null)

	if (options.countries?.length) {
		query = query.where("country", "in", [...options.countries])
	}

	const rows = await query.execute()

	return rows.map((row) => ({
		designatorID: designatorByID.get(row.category_id)!,
		name: row.name,
		country: row.country,
		category: categoryByID.get(row.category_id)!,
	}))
}
