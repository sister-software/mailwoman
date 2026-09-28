/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Admin-gazetteer enrichment, the two post-build steps that must run in order:
 *
 *   1. Region abbreviations: WOF region records carry only the full name. `findPlace('IL')`
 *      returns no place without the abbreviation, killing the parent constraint the resolve walk
 *      depends on. The source of truth is the packaged chromium-i18n / libaddressinput dataset
 *      (`core/data/chromium-i18n/ssl-address/<CC>.json`), whose tilde-delimited `sub_keys` and
 *      `sub_names` are index-aligned. These fields supply the abbreviations.
 *   2. `place_abbr`, the `id → abbreviation` join table that lets the resolver accept a 2-letter
 *      region abbreviation as an exact match. Derived from the step-1 rows, so it must run after
 *      them. Both enrichment steps must precede the FTS build.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { corePackagePathBuilder } from "@mailwoman/core/paths"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder, type PathBuilderLike } from "path-ts"

export interface EnrichAdminOptions {
	/**
	 * Chromium-i18n ssl-address spec dir.
	 * Defaults to the dataset packaged with `@mailwoman/core`.
	 */
	specsDir?: PathBuilderLike
}

export interface EnrichAdminResult {
	abbrevNamesAdded: number
	abbrevCountries: number
	placeAbbrRows: number
}

/**
 * Enrich an admin staging DB with region-abbreviation `names` rows and the `place_abbr` join table.
 * Idempotent.
 */
export async function enrichAdmin<DB>(
	db: DatabaseClient<DB>,
	opts: EnrichAdminOptions = {}
): Promise<EnrichAdminResult> {
	const specsDir = PathBuilder.from(opts.specsDir ?? corePackagePathBuilder("data", "chromium-i18n", "ssl-address"))

	db.exec("DELETE FROM names WHERE language = 'abbr'")

	// One read of every region row, bucketed by country.
	const regionsByCountry = new Map<string, Array<{ id: number; name: string }>>()

	for (const row of db.prepare("SELECT id, name, country FROM spr WHERE placetype='region'").all() as Array<{
		id: number
		name: string
		country: string
	}>) {
		if (!row.country) continue
		let bucket = regionsByCountry.get(row.country)

		if (!bucket) {
			regionsByCountry.set(row.country, (bucket = []))
		}

		bucket.push({ id: row.id, name: row.name })
	}

	const insert = db.prepare(
		"INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'region', ?, 'abbr', 0)"
	)

	let added = 0

	for (const [cc, regions] of regionsByCountry) {
		const specPath = specsDir(`${cc}.json`)

		if (!(await pathExists(specPath))) continue
		const spec = await readLocalJSONFile<{ sub_keys?: string; sub_names?: string }>(specPath)

		if (!spec.sub_keys || !spec.sub_names) continue
		const keys = spec.sub_keys.split("~")
		const names = spec.sub_names.split("~")
		const nameToAbbr = new Map<string, string>()

		for (let i = 0; i < Math.min(keys.length, names.length); i++) {
			const n = names[i]?.trim().toLowerCase()

			if (n && keys[i]) {
				nameToAbbr.set(n, keys[i]!)
			}
		}

		db.exec("BEGIN")

		for (const r of regions) {
			const abbr = nameToAbbr.get(String(r.name).trim().toLowerCase())

			if (abbr && abbr.toLowerCase() !== String(r.name).toLowerCase()) {
				insert.run(r.id, abbr, cc)

				added++
			}
		}

		db.exec("COMMIT")
	}

	// `place_abbr` is rebuilt from the rows above and dropped first so a re-run stays idempotent.
	db.exec("DROP TABLE IF EXISTS place_abbr")
	db.exec("CREATE TABLE place_abbr (id INTEGER NOT NULL, abbr TEXT NOT NULL)")
	db.exec("INSERT INTO place_abbr (id, abbr) SELECT id, name FROM names WHERE language = 'abbr'")
	db.exec("CREATE INDEX place_abbr_by_abbr ON place_abbr (abbr COLLATE NOCASE)")
	db.exec("CREATE INDEX place_abbr_by_id ON place_abbr (id)")
	const placeAbbrRows = (db.prepare("SELECT COUNT(*) n FROM place_abbr").get() as { n: number }).n

	return { abbrevNamesAdded: added, abbrevCountries: regionsByCountry.size, placeAbbrRows }
}
