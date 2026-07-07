/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Admin-gazetteer enrichment — the two post-build steps the #1015 rebuild missed because they lived
 *   as separate scripts, now unskippable pipeline steps:
 *
 *   1. **Region abbreviations** (ports `scripts/add-region-abbrevs.ts`): WOF region records carry only
 *      the full name ("Illinois"); `findPlace('IL')` returned nothing, killing the parent-constraint
 *      the whole resolve walk depends on. Source of truth is the packaged chromium-i18n /
 *      libaddressinput dataset (`core/data/chromium-i18n/ssl-address/<CC>.json`): `sub_keys`
 *      (abbreviations) ↔ `sub_names` (full names), tilde-delimited and index-aligned.
 *   2. **`place_abbr`** (the `id → abbreviation` join table, from `build-slim.ts`): lets the resolver
 *      accept a 2-letter region abbreviation as an exact match. Derived from the step-1 rows, so this
 *      MUST run after them — and both MUST precede the FTS build (`place_search` concatenates `names`).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"

import { corePackagePathBuilder } from "@mailwoman/core/utils"

export interface EnrichAdminOptions {
	/** Chromium-i18n ssl-address spec dir. Default: the dataset packaged with `@mailwoman/core`. */
	specsDir?: string
}

export interface EnrichAdminResult {
	abbrevNamesAdded: number
	abbrevCountries: number
	placeAbbrRows: number
}

/** Enrich an admin staging DB: region-abbreviation `names` rows + the `place_abbr` join table. Idempotent. */
export function enrichAdmin(db: DatabaseSync, opts: EnrichAdminOptions = {}): EnrichAdminResult {
	const specsDir = opts.specsDir ?? String(corePackagePathBuilder("data", "chromium-i18n", "ssl-address"))

	db.exec("DELETE FROM names WHERE language = 'abbr'") // idempotent re-run

	const countries = (
		db.prepare("SELECT DISTINCT country FROM spr WHERE placetype='region'").all() as Array<{ country: string }>
	)
		.map((r) => r.country)
		.filter(Boolean)

	const insert = db.prepare(
		"INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'region', ?, 'abbr', 0)"
	)

	let added = 0

	for (const cc of countries) {
		const specPath = join(specsDir, `${cc}.json`)

		if (!existsSync(specPath)) continue
		const spec = JSON.parse(readFileSync(specPath, "utf8")) as { sub_keys?: string; sub_names?: string }

		if (!spec.sub_keys || !spec.sub_names) continue
		const keys = spec.sub_keys.split("~")
		const names = spec.sub_names.split("~")
		const nameToAbbr = new Map<string, string>()

		for (let i = 0; i < Math.min(keys.length, names.length); i++) {
			const n = names[i]?.trim().toLowerCase()

			if (n && keys[i]) nameToAbbr.set(n, keys[i]!)
		}
		const regions = db.prepare("SELECT id, name FROM spr WHERE placetype='region' AND country = ?").all(cc) as Array<{
			id: number
			name: string
		}>
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

	// `place_abbr` — the id → abbreviation join the resolver probes for 2-letter exact matches. Rebuilt
	// from the rows above (the build-slim.ts recipe); DROP first so a re-run stays idempotent.
	db.exec("DROP TABLE IF EXISTS place_abbr")
	db.exec("CREATE TABLE place_abbr (id INTEGER NOT NULL, abbr TEXT NOT NULL)")
	db.exec("INSERT INTO place_abbr (id, abbr) SELECT id, name FROM names WHERE language = 'abbr'")
	db.exec("CREATE INDEX place_abbr_by_abbr ON place_abbr (abbr COLLATE NOCASE)")
	db.exec("CREATE INDEX place_abbr_by_id ON place_abbr (id)")
	const placeAbbrRows = (db.prepare("SELECT COUNT(*) n FROM place_abbr").get() as { n: number }).n

	return { abbrevNamesAdded: added, abbrevCountries: countries.length, placeAbbrRows }
}
