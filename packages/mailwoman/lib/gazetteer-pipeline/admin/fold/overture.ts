/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Backfills the admin gazetteer from the Overture `divisions` theme for countries that WOF does not
 *   cover. The country list lives in `../defaults.ts`.
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { simpleSHA3 } from "@mailwoman/core/crypto"
import { tryParsingJSON } from "@mailwoman/core/json"
import { OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
// This import is type-only because the package is an optional peer that callers load lazily.
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite"
import type { DatabaseClient, StatementSync } from "@mailwoman/sqlite/client"
import { sql } from "kysely"

/**
 * Overture division subtypes that map to the resolver's admin placetypes.
 *
 * The list includes `country` so a backfilled country has a country node for
 * reverse geocoding and country scoping.
 */
export const OVERTURE_DIVISION_SUBTYPES = ["country", "locality", "region", "county", "localadmin"]

/**
 * Countries whose Overture `county` divisions are settlements, mapped to the placetype to write instead.
 *
 * No admin tag queries the `county` placetype, because the locality filter group
 * covers only `locality`, `borough`, and `localadmin`.
 * Singapore's planning areas, such as Bedok, arrive as `county`, so the fold
 * writes them as `borough` to make them reachable.
 *
 * The list is explicit because a general rule would also admit other countries' `county` rows,
 * such as Kuwait's underscore-joined ASCII names and Qatar's numbered zones.
 */
const COUNTY_IS_SETTLEMENT_TIER: ReadonlyMap<string, string> = new Map([["SG", "borough"]])

/**
 * Returns the placetype to write for a division.
 *
 * This is the Overture subtype unless {@link COUNTY_IS_SETTLEMENT_TIER} maps the
 * country's `county` rows to another placetype.
 */
export function foldedPlacetype(subtype: string, country: string): string {
	if (subtype !== "county") return subtype

	return COUNTY_IS_SETTLEMENT_TIER.get(country.trim().toUpperCase()) ?? subtype
}

/**
 * The width of the ID range reserved for Overture rows.
 *
 * It runs from `OVERTURE_ID_BASE` up to the GeoNames fold's base.
 */
const OVERTURE_ID_SPAN = 1_000_000_000_000

/**
 * Bracket, pipe, and delimiter characters that mark an editorial aside in a name field.
 */
const NAME_NOISE = /[()[\]{}<>|/\\_@#$%^*+=~`"]/u

/**
 * The maximum name length.
 * It rejects descriptions that ran into the name field.
 */
const NAME_MAX_LENGTH = 120

/**
 * Returns whether a `names.common` entry is usable as a name.
 *
 * The check accepts any script.
 * For countries whose primary name is Latin, `common` is the only place local-script names appear.
 */
export function isDivisionName(value: string): boolean {
	return value.length <= NAME_MAX_LENGTH && /\p{L}/u.test(value) && !NAME_NOISE.test(value)
}

/**
 * The number of digest bytes drawn per GERS ID.
 *
 * Six bytes (48 bits) exceed {@link OVERTURE_ID_SPAN} and stay exactly representable as a JS number.
 */
const ID_DIGEST_BYTES = 6

/**
 * The radix of {@link simpleSHA3}'s hex digest.
 */
const HEX_RADIX = 16

/**
 * Maps each Overture GERS ID to a synthetic integer ID derived from a hash of the GERS ID.
 *
 * Consumers store these IDs, so an ID must depend on the place and not on the build's scan order.
 * Each ID is `idBase + (hash(gers) mod span)`.
 *
 * On a collision, the later ID probes forward to the next free slot.
 * The input is sorted first so the probing does not depend on query order.
 */
export function assignSyntheticIDs(gersIDs: readonly string[], idBase: number = OVERTURE_ID_BASE): Map<string, number> {
	const idmap = new Map<string, number>()
	const taken = new Set<number>()

	for (const gers of gersIDs.toSorted()) {
		if (idmap.has(gers)) continue

		let slot = Number.parseInt(simpleSHA3([gers], ID_DIGEST_BYTES), HEX_RADIX) % OVERTURE_ID_SPAN

		while (taken.has(slot)) {
			slot = (slot + 1) % OVERTURE_ID_SPAN
		}

		taken.add(slot)
		idmap.set(gers, idBase + slot)
	}

	return idmap
}

/**
 * The columns each bulk insert writes, in the order that its positional `run()` call supplies them.
 *
 * The `satisfies` clauses check every name against `WOFDatabase`, so a renamed column fails to compile.
 * The inserts use raw positional statements because this is a high-volume bulk-write path.
 */
const SPR_COLUMNS = [
	"id",
	"parent_id",
	"name",
	"placetype",
	"country",
	"latitude",
	"longitude",
	"min_latitude",
	"min_longitude",
	"max_latitude",
	"max_longitude",
	"is_current",
	"is_deprecated",
	"is_ceased",
	"is_superseded",
	"is_superseding",
	"lastmodified",
] as const satisfies ReadonlyArray<keyof WOFDatabase["spr"]>

const NAMES_COLUMNS = [
	"id",
	"name",
	"placetype",
	"country",
	"language",
	"official",
	"lastmodified",
] as const satisfies ReadonlyArray<keyof WOFDatabase["names"]>

const POPULATION_COLUMNS = ["id", "population"] as const satisfies ReadonlyArray<keyof WOFDatabase["place_population"]>

const CONCORDANCE_COLUMNS = ["id", "other_id", "other_source", "lastmodified"] as const satisfies ReadonlyArray<
	keyof WOFDatabase["concordances"]
>

/**
 * Compiles a positional insert statement for one of the column tuples above.
 *
 * Kysely's `sql` helper quotes the identifiers and generates one placeholder per column.
 * The result is a plain SQL string for `db.prepare`, so the statement can be
 * prepared once and run for every row.
 */
function compileInsert(
	kdb: DatabaseClient<WOFDatabase>,
	table: keyof WOFDatabase,
	columns: readonly string[],
	orReplace = false
): string {
	const conflict = orReplace ? sql`or replace ` : sql``
	const names = sql.join(columns.map((column) => sql.ref(column)))
	const placeholders = sql.join(columns.map(() => sql.raw("?")))

	return sql`insert ${conflict}into ${sql.table(table)} (${names}) values (${placeholders})`.compile(kdb).sql
}

/**
 * Prepares the bulk-write statements against an open unified database.
 *
 * It is exported so a test can run the statements against a real `createUnifiedSchema` database.
 * The `satisfies` checks compare the columns with the `WOFDatabase` interface only,
 * and the DDL can drift from that interface.
 */
export function prepareInserts(db: DatabaseClient<WOFDatabase>): {
	spr: StatementSync
	names: StatementSync
	population: StatementSync
	concordances: StatementSync
} {
	const kdb = db

	return {
		spr: db.prepare(compileInsert(kdb, "spr", SPR_COLUMNS, true)),
		names: db.prepare(compileInsert(kdb, "names", NAMES_COLUMNS)),
		population: db.prepare(compileInsert(kdb, "place_population", POPULATION_COLUMNS, true)),
		concordances: db.prepare(compileInsert(kdb, "concordances", CONCORDANCE_COLUMNS)),
	}
}

/**
 * Backfills the Overture `divisions` theme into an open unified ingest database.
 *
 * It writes the same `spr`, `names`, `place_population`, and `concordances` tables as
 * the WOF path, with synthetic IDs from {@link assignSyntheticIDs}.
 * A division whose parent was not ingested gets parent ID -1.
 * Every row carries `spr.country` for country scoping.
 *
 * The native `@duckdb/node-api` dependency is imported lazily so the module loads without it.
 *
 * @returns The number of divisions ingested.
 */
export async function ingestOvertureDivisions(
	db: DatabaseClient<WOFDatabase>,
	countries: readonly string[],
	release: string,
	/**
	 * The base of the synthetic ID range. It defaults to {@link OVERTURE_ID_BASE}.
	 */
	idBase: number = OVERTURE_ID_BASE
): Promise<number> {
	const inlist = countries.map((c) => `'${c.replaceAll("'", "''")}'`).join(",")
	const subtypes = OVERTURE_DIVISION_SUBTYPES.map((s) => `'${s}'`).join(",")
	const glob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division/*`
	// The `type=division` row's bbox is only its label point.
	// The query takes the real extent from the matching `type=division_area` rows
	// and falls back to the point bbox when a division has no area.
	const areaGlob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division_area/*`

	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const con = await instance.connect()

	await con.run(
		/* sql */ `install httpfs; load httpfs; install spatial; load spatial; install json; load json; SET s3_region='us-west-2';`
	)

	await con.run(/* sql */ `SET memory_limit='4GB'; SET threads=4;`)

	console.error(`  Overture divisions: querying ${countries.join(",")} @ release ${release}...`)

	const result = await con.runAndReadAll(/*sql*/ `
		WITH area AS (
			SELECT division_id,
				MIN(bbox.ymin) AS ymin, MAX(bbox.ymax) AS ymax, MIN(bbox.xmin) AS xmin, MAX(bbox.xmax) AS xmax
			FROM read_parquet('${areaGlob}')
			WHERE country IN (${inlist})
			GROUP BY division_id
		)
		SELECT d.id AS id,
			d.names.primary AS name,
			to_json(d.names.common) AS common_json,
			d.subtype AS subtype,
			d.country AS country,
			ST_Y(ST_Centroid(d.geometry)) AS lat,
			ST_X(ST_Centroid(d.geometry)) AS lon,
			COALESCE(a.ymin, d.bbox.ymin) AS min_lat, COALESCE(a.ymax, d.bbox.ymax) AS max_lat,
			COALESCE(a.xmin, d.bbox.xmin) AS min_lon, COALESCE(a.xmax, d.bbox.xmax) AS max_lon,
			d.parent_division_id AS parent_division_id,
			d.population AS population,
			d.wikidata AS wikidata
		FROM read_parquet('${glob}') d
		LEFT JOIN area a ON a.division_id = d.id
		WHERE d.country IN (${inlist}) AND d.subtype IN (${subtypes})
			AND d.names.primary IS NOT NULL AND d.geometry IS NOT NULL
	`)

	const rows = result.getRowObjects() as Array<Record<string, unknown>>

	console.error(`  Overture divisions: ${rows.length.toLocaleString()} pulled`)

	const idmap = assignSyntheticIDs(
		rows.map((r) => String(r.id)),
		idBase
	)

	const {
		spr: sprInsert,
		names: namesInsert,
		population: populationInsert,
		concordances: concordancesInsert,
	} = prepareInserts(db)

	const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0)

	db.exec("BEGIN")
	let n = 0
	let nWikidata = 0

	for (const r of rows) {
		const nid = idmap.get(String(r.id))!
		const pgers = r.parent_division_id == null ? null : String(r.parent_division_id)
		const pid = (pgers && idmap.get(pgers)) || -1
		const name = String(r.name)
		const country = String(r.country ?? "").toUpperCase()
		const placetype = foldedPlacetype(String(r.subtype), country)

		// The argument order must match SPR_COLUMNS.
		sprInsert.run(
			nid,
			pid,
			name,
			placetype,
			country,
			num(r.lat),
			num(r.lon),
			num(r.min_lat),
			num(r.min_lon),
			num(r.max_lat),
			num(r.max_lon),
			1,
			0,
			0,
			0,
			0,
			0
		)

		namesInsert.run(nid, name, placetype, country, "", 0, 0)

		// `names.common` maps a language to that language's standard name.
		// Each one becomes an alias, and an alias is official when its language is
		// an official language of the country.
		if (r.common_json) {
			// A malformed map parses to null, and the row keeps only its primary name.
			const common = tryParsingJSON<Record<string, string>>(String(r.common_json))

			if (common) {
				const seen = new Set([name])

				for (const [lang, alias] of Object.entries(common)) {
					if (typeof alias === "string" && !seen.has(alias) && isDivisionName(alias)) {
						seen.add(alias)
						namesInsert.run(nid, alias, placetype, country, lang, isOfficialLanguage(country, lang) ? 1 : 0, 0)
					}
				}
			}
		}

		// The Wikidata ID uses the same `wd:id` source as the WOF ingest,
		// so `gazetteer importance` can join Overture rows the same way.
		if (typeof r.wikidata === "string" && r.wikidata.startsWith("Q")) {
			concordancesInsert.run(nid, r.wikidata, "wd:id", 0)

			nWikidata++
		}

		const pop = num(r.population)

		if (pop > 0) {
			populationInsert.run(nid, pop)
		}

		n++
	}

	db.exec("COMMIT")

	console.error(
		`  Overture divisions: ${nWikidata.toLocaleString()} of ${n.toLocaleString()} carry a Wikidata concordance`
	)

	return n
}
