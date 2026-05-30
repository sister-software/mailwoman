/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Enrich a unified WOF DB's `names` table with region (state/province) ABBREVIATIONS, so the
 *   resolver can resolve realistic addresses like "Springfield, IL" — WOF region records carry only
 *   the full name ("Illinois"), and `findPlace('IL')` returns nothing, which kills the parent-
 *   constraint the whole resolve walk depends on (see the Direction-C resolver eval).
 *
 *   Source of truth is the chromium-i18n / libaddressinput dataset already in the repo
 *   (`core/data/chromium-i18n/ssl-address/<CC>.json`): `sub_keys` (abbreviations) ↔ `sub_names`
 *   (full names), tilde-delimited and index-aligned, for every country. We match each WOF region by
 *   name and add its abbreviation as a `names` row; `build-fts` then concatenates it into
 *   `place_search` so the abbreviation is searchable.
 *
 *   Run AFTER build-unified-wof and BEFORE build-fts (see scripts/wof-build-manifest.json): node
 *   --experimental-strip-types scripts/add-region-abbrevs.ts <unified.db> [<specs-dir>] Idempotent:
 *   clears prior language='abbr' rows first.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const dbPath = process.argv[2] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
const specsDir = process.argv[3] ?? "core/data/chromium-i18n/ssl-address"

const db = new DatabaseSync(dbPath)
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
db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
db.exec("PRAGMA journal_mode = DELETE")
db.close()
console.error(`added ${added} region-abbreviation names across ${countries.length} countries`)
