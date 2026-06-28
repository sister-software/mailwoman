/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Repair the unified WOF DB's `ancestors` table for places that `populateAncestors`
 *   (build-unified-wof.ts, a parent_id closure) leaves with ONLY-SELF ancestry.
 *
 *   Root cause (#440): a place that spans multiple parents — e.g. New York City, which straddles five
 *   counties (the boroughs) — carries `wof:parent_id = -4` (the WOF "ambiguous / no single parent"
 *   sentinel). The parent_id closure dead-ends there, so the place gets no region/county/country
 *   ancestry. The resolver's region-descendant boost then can't reach it: given "New York, NY", NYC
 *   (no NY-state ancestor) loses the boost to a correctly-parented namesake like "New York Mills",
 *   which wins despite NYC's 8.8M population. The honest-eval harness caught this as a metro
 *   regression once region resolution was fixed (docs/articles/evals/2026-06-08-honest-eval.md).
 *
 *   The authoritative hierarchy IS in the source geojson: `wof:hierarchy` is an array of branches,
 *   each a map of `<placetype>_id` → id (region_id, county_id, country_id, …), fully populated even
 *   when parent_id is -4. This script reads it for every only-self place and inserts the missing
 *   ancestor rows (one per distinct ancestor across branches).
 *
 *   Run AFTER build-unified-wof and add-region-abbrevs, BEFORE build-fts (FTS doesn't depend on
 *   ancestors, so order vs FTS is not strict; keep it with the other post-build steps): node
 *   --experimental-strip-types scripts/backfill-ancestors-from-hierarchy.ts <unified.db>
 *   [<repos-root>] Idempotent: only touches places whose current ancestry is <= 1 row (self only),
 *   and inserts each (id, ancestor_id) at most once.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const dbPath = process.argv[2] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
const reposRoot = process.argv[3] ?? "/mnt/playpen/mailwoman-data/wof/repos"

// WOF geojson lives sharded under several admin repos; an id resolves to <root>/<3-char chunks>/<id>.geojson.
const adminRoots: string[] = []

for (const sub of [
	"whosonfirst-data/whosonfirst-data-admin-cn",
	"whosonfirst-data/whosonfirst-data-admin-de",
	"whosonfirst-data/whosonfirst-data-admin-es",
	"whosonfirst-data/whosonfirst-data-admin-fr",
	"whosonfirst-data/whosonfirst-data-admin-gb",
	"whosonfirst-data/whosonfirst-data-admin-it",
	"whosonfirst-data/whosonfirst-data-admin-jp",
	"whosonfirst-data/whosonfirst-data-admin-kr",
	"whosonfirst-data/whosonfirst-data-admin-nl",
	"whosonfirst-data/whosonfirst-data-admin-us",
	"whosonfirst-data-admin-us",
]) {
	const p = join(reposRoot, sub, "data")

	if (existsSync(p)) adminRoots.push(p)
}

function geojsonForId(id: number): Record<string, unknown> | null {
	const s = String(id)
	const chunks: string[] = []

	for (let i = 0; i < s.length; i += 3) chunks.push(s.slice(i, i + 3))
	const rel = join(chunks.join("/"), `${s}.geojson`)

	for (const root of adminRoots) {
		const fp = join(root, rel)

		if (existsSync(fp)) {
			try {
				return JSON.parse(readFileSync(fp, "utf8")) as Record<string, unknown>
			} catch {
				return null
			}
		}
	}

	return null
}

// `<placetype>_id` key → ancestor placetype. WOF hierarchy keys are e.g. region_id, county_id.
// Self is filtered downstream by the `aid === id` check, so we do NOT special-case locality here:
// for a locality candidate `locality_id` IS self (dropped by aid===id), but for a neighbourhood
// candidate `locality_id` is its PARENT locality — a real ancestor we must keep.
function placetypeFromKey(key: string): string | null {
	if (!key.endsWith("_id")) return null

	return key.slice(0, -3)
}

const db = new DatabaseSync(dbPath)

// Places with only-self (or zero) ancestry, excluding genuinely top-level placetypes.
const TOP = new Set(["country", "continent", "empire", "ocean", "marinearea", "planet"])
const candidates = db
	.prepare(
		`SELECT s.id AS id, s.placetype AS placetype FROM spr s
		 WHERE (SELECT count(*) FROM ancestors a WHERE a.id = s.id) <= 1`
	)
	.all() as Array<{ id: number; placetype: string }>

const insert = db.prepare(
	"INSERT INTO ancestors (id, ancestor_id, ancestor_placetype, lastmodified) VALUES (?, ?, ?, 0)"
)
const hasRow = db.prepare("SELECT 1 FROM ancestors WHERE id = ? AND ancestor_id = ? LIMIT 1")

let placesFixed = 0
let rowsAdded = 0
let noGeojson = 0
db.exec("BEGIN")

for (const { id, placetype } of candidates) {
	if (TOP.has(placetype)) continue
	const gj = geojsonForId(id)
	const props = (gj?.["properties"] ?? null) as Record<string, unknown> | null
	const hierarchy = (props?.["wof:hierarchy"] ?? null) as Array<Record<string, number>> | null

	if (!hierarchy || hierarchy.length === 0) {
		if (!gj) noGeojson++
		continue
	}
	// Collect distinct (ancestor_id, placetype) across all hierarchy branches, excluding self.
	const seen = new Map<number, string>()

	for (const branch of hierarchy) {
		for (const [key, val] of Object.entries(branch)) {
			const pt = placetypeFromKey(key)

			if (!pt) continue
			const aid = Number(val)

			if (!Number.isFinite(aid) || aid <= 0 || aid === id) continue

			if (!seen.has(aid)) seen.set(aid, pt)
		}
	}
	let added = 0

	for (const [aid, pt] of seen) {
		if (hasRow.get(id, aid)) continue
		insert.run(id, aid, pt)
		added++
	}

	if (added > 0) {
		placesFixed++
		rowsAdded += added
	}
}
db.exec("COMMIT")
db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
db.close()
console.error(
	`backfilled ancestry for ${placesFixed} places (+${rowsAdded} rows); ${noGeojson} candidates had no source geojson`
)
