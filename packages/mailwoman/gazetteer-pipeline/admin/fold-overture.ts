/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Overture `divisions`-theme backfill for the admin gazetteer — the zero-WOF-repo locales
 *   (project-eu-coverage-not-retrain, widened to the 86-country set; see `../defaults.ts`). Moved from
 *   `scripts/build-unified-wof.ts` (#1015/#1021) into the pipeline module.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite"

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { simpleSHA3 } from "@mailwoman/core/crypto"
import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { tryParsingJSON } from "@mailwoman/core/objects"
// Type-only, so it is erased at build and adds no runtime edge to what is an optional peer here (the
// caller reaches the package through a lazy `await import`).
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite"
import { sql } from "kysely"

/**
 * Synthetic id base for Overture-sourced rows — above any real WOF id (WOF ids are <~2e9), so a combined DB never
 * collides across sources.
 */
export const OVERTURE_ID_BASE = 8_000_000_000_000

/**
 * Overture division subtypes that map to the resolver's admin placetypes. `country` is included (#1015) so an
 * Overture-backfilled locale gets its country node — without it the reverse geocoder has no country tier to anchor to
 * (Brussels → nearest FOREIGN place across the border), and forward resolution can't country-gate the locale.
 */
export const OVERTURE_DIVISION_SUBTYPES = ["country", "locality", "region", "county", "localadmin"]

/**
 * Width of the id range reserved for Overture rows — `OVERTURE_ID_BASE` up to the GeoNames fold's base at 9e12.
 */
const OVERTURE_ID_SPAN = 1_000_000_000_000

/**
 * Digest bytes to draw per GERS id. Six (48 bits, ~2.8e14) overshoots {@link OVERTURE_ID_SPAN} comfortably, so the
 * modulo costs nothing in collision terms, and the value stays exactly representable as a JS number.
 */
const ID_DIGEST_BYTES = 6

/**
 * Radix of {@link simpleSHA3}'s hex digest.
 */
const HEX_RADIX = 16

/**
 * Map each Overture GERS id to a synthetic integer id, derived from the GERS id itself.
 *
 * Consumers store these ids — gold rows, cached results, cross-artifact joins — so an id has to be a function of the
 * PLACE, not of the build that emitted it. GERS ids are stable by design; parquet scan order is not, and DuckDB's is a
 * threaded read over a LEFT JOIN.
 *
 * Assignment is `idBase + (hash(gers) mod span)`. Two GERS ids can land on the same slot — at ~1.6 M rows in a 1e12
 * span the birthday expectation is about one collision per build — so the loser probes forward. Probing is order-
 * dependent, which is exactly what this function exists to avoid, so the input is SORTED first: a given GERS id's
 * outcome then depends only on the set of ids that hash near it, not on how the query happened to return them.
 *
 * Re-ingesting a division already present recomputes the same id, so an incremental augment is idempotent.
 */
export function assignSyntheticIDs(gersIDs: readonly string[], idBase: number = OVERTURE_ID_BASE): Map<string, number> {
	const idmap = new Map<string, number>()
	const taken = new Set<number>()

	for (const gers of gersIDs.toSorted()) {
		if (idmap.has(gers)) continue

		// SHAKE128 is an extendable-output function, so a six-byte digest is the primitive doing what it
		// was designed for rather than a truncation of a wider hash.
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
 * Columns each bulk INSERT below writes, in the order its positional `run()` supplies them.
 *
 * `satisfies` checks every name against Kysely's `WOFDatabase` — the same interface `createUnifiedSchema` builds these
 * tables from — so a renamed or dropped column is a compile error here rather than a runtime `no such column` in the
 * middle of a multi-hour build. The statements themselves stay raw positional prepares: this is the throughput path
 * (~1.6 M divisions, three writes each), which is the bulk-write carve-out the repo's SQL policy names.
 *
 * The run() argument order below MUST match these tuples.
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

/**
 * Compile a positional INSERT for one of the tuples above.
 *
 * Built through Kysely's `sql` helper rather than by concatenation: `sql.table`/`sql.ref` quote the identifiers, and
 * the placeholder list is generated FROM the column list, so the two cannot fall out of step. The result is a plain SQL
 * string for `db.prepare` — Kysely's own `insertInto().values()` binds a row per call, which is the wrong shape for a
 * statement prepared once and run 1.6 M times.
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
 * The three bulk-write statements, prepared against an open unified DB.
 *
 * Exported so a test can run them against a REAL `createUnifiedSchema` database. The `satisfies` above checks the
 * column tuples against the `WOFDatabase` INTERFACE, which is a different artifact from the DDL that builds the tables
 * — the two can drift, and the only thing that catches it is binding a row.
 */
export function prepareInserts(db: DatabaseSync): {
	spr: StatementSync
	names: StatementSync
	population: StatementSync
} {
	// Wraps the caller's handle for statement compilation only — the same one-connection idiom
	// `createUnifiedSchema` uses for its DDL. The caller owns `db`'s lifecycle, so this is not destroyed.
	const kdb = new DatabaseClient<WOFDatabase>({ database: db })

	return {
		spr: db.prepare(compileInsert(kdb, "spr", SPR_COLUMNS, true)),
		names: db.prepare(compileInsert(kdb, "names", NAMES_COLUMNS)),
		population: db.prepare(compileInsert(kdb, "place_population", POPULATION_COLUMNS, true)),
	}
}

/**
 * Backfill the Overture `divisions` theme into an already-open unified ingest DB, for locales the WOF GeoJSON repos
 * don't cover. Writes the SAME spr/names/place_population tables the WOF path uses — with synthetic ids based at
 * {@link OVERTURE_ID_BASE} so the two sources never collide — so the caller's Freeze phase (ancestors closure,
 * coincident_roles, indexes, FTS) treats them uniformly. The Overture sub-tree is self-contained (locality → region →
 * county via `parent_division_id`); a division whose parent we didn't ingest tops out at -1. Country scoping rides
 * `spr.country` (set on every row), not the ancestry — but the `country` subtype ships the country NODE too (#1015).
 *
 * The heavy native `@duckdb/node-api` dependency is loaded LAZILY (the `overture-ingest.tsx` convention) so importing
 * the pipeline module never faults when the optional binding isn't installed.
 *
 * @returns The number of divisions ingested.
 */
export async function ingestOvertureDivisions(
	db: DatabaseSync,
	countries: readonly string[],
	release: string,
	/**
	 * Starting synthetic id. Defaults to {@link OVERTURE_ID_BASE} (a single full build). An INCREMENTAL augment of a DB
	 * that ALREADY holds Overture rows MUST pass `max(spr.id) + 1` so the new ids don't collide with — and `INSERT OR
	 * REPLACE` clobber — the existing ones.
	 */
	idBase: number = OVERTURE_ID_BASE
): Promise<number> {
	const inlist = countries.map((c) => `'${c.replaceAll("'", "''")}'`).join(",")
	const subtypes = OVERTURE_DIVISION_SUBTYPES.map((s) => `'${s}'`).join(",")
	const glob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division/*`
	// #1015: the real boundary EXTENT lives in the sibling `type=division_area` (the polygon). The `type=division`
	// row is the label POINT — its `bbox` is a degenerate point, so relying on it left every Overture-backfilled
	// place with a point bbox, invisible to the reverse geocoder's bbox-containment (Brussels resolved to a foreign
	// cross-border neighbour). Join the area's extent by `division_id`, falling back to the point bbox when a
	// division has no area row (so nothing regresses).
	const areaGlob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division_area/*`

	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const con = await instance.connect()

	await con.run(
		/* sql */ `INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; INSTALL json; LOAD json; SET s3_region='us-west-2';`
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
			d.population AS population
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

	const { spr: sprInsert, names: namesInsert, population: populationInsert } = prepareInserts(db)

	const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0)
	// Keep only Latin-script common-name aliases (English + major-language transliterations — the names a
	// Latin-keyboard user actually queries: "Moscow", "Moscou", "Moskva"). The local-script primary
	// (Москва, القاهرة) is kept separately; obscure non-Latin aliases (Armenian, Mingrelian, …) would
	// bloat the candidate for ~zero query value.
	const isLatin = (s: string): boolean => /^[\p{Script=Latin}\p{N}\p{P}\s]+$/u.test(s)

	db.exec("BEGIN")
	let n = 0

	for (const r of rows) {
		const nid = idmap.get(String(r.id))!
		const pgers = r.parent_division_id == null ? null : String(r.parent_division_id)
		const pid = (pgers && idmap.get(pgers)) || -1
		const name = String(r.name)
		const subtype = String(r.subtype)
		const country = String(r.country ?? "").toUpperCase()

		// SELECT aliases: min_lat=ymin, min_lon=xmin, max_lat=ymax, max_lon=xmax → spr (lat, lon,
		// min_latitude, min_longitude, max_latitude, max_longitude).
		sprInsert.run(
			nid,
			pid,
			name,
			subtype,
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

		namesInsert.run(nid, name, subtype, country, "", 0, 0)

		// Multilingual aliases (names.common — language→name, incl. English / Latin transliterations) so a
		// non-Latin-script place (Москва, القاهرة, กรุงเทพมหานคร) still resolves by its English/Latin name.
		// The candidate build explodes every alias here into its own name_key. Overture `common` is the
		// standard name per language (no variant axis), so #936 officialness is the language test alone.
		if (r.common_json) {
			// A malformed common map nulls out — keep the primary, skip aliases.
			const common = tryParsingJSON<Record<string, string>>(String(r.common_json))

			if (common) {
				const seen = new Set([name])

				for (const [lang, alias] of Object.entries(common)) {
					if (typeof alias === "string" && alias.length && !seen.has(alias) && isLatin(alias)) {
						seen.add(alias)
						namesInsert.run(nid, alias, subtype, country, lang, isOfficialLanguage(country, lang) ? 1 : 0, 0)
					}
				}
			}
		}

		const pop = num(r.population)

		if (pop > 0) {
			populationInsert.run(nid, pop)
		}

		n++
	}

	db.exec("COMMIT")

	return n
}
