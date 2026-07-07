/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Overture `divisions`-theme backfill for the admin gazetteer — the zero-WOF-repo locales
 *   (project-eu-coverage-not-retrain, widened to the 86-country set; see `../defaults.ts`). Moved from
 *   `scripts/build-unified-wof.ts` (#1015/#1021) into the pipeline module.
 */

import type { DatabaseSync } from "node:sqlite"

import { isOfficialLanguage } from "@mailwoman/codex/country"

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
	const inlist = countries.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")
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
		"INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; INSTALL json; LOAD json; SET s3_region='us-west-2';"
	)
	await con.run("SET memory_limit='4GB'; SET threads=4;")

	console.error(`  Overture divisions: querying ${countries.join(",")} @ release ${release}...`)
	const result = await con.runAndReadAll(`
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

	// GERS string id → synthetic int, sequential and unique within this run.
	const idmap = new Map<string, number>()
	rows.forEach((r, i) => idmap.set(String(r.id), idBase + i))

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, official, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
	const populationInsert = db.prepare(`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`)

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
			try {
				const common = JSON.parse(String(r.common_json)) as Record<string, string>
				const seen = new Set([name])

				for (const [lang, alias] of Object.entries(common)) {
					if (typeof alias === "string" && alias.length > 0 && !seen.has(alias) && isLatin(alias)) {
						seen.add(alias)
						namesInsert.run(nid, alias, subtype, country, lang, isOfficialLanguage(country, lang) ? 1 : 0, 0)
					}
				}
			} catch {
				/* malformed common map — keep the primary, skip aliases */
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
