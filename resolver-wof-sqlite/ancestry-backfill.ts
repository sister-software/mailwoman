/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Repair the only-self ancestry that {@link populateAncestors} (the parent_id closure in
 *   unified-schema.ts) leaves for places whose `wof:parent_id` is the WOF `-4` "ambiguous /
 *   multi-parent" sentinel.
 *
 *   Root cause (#440 / #832): a place that straddles multiple parents — New York City spans five
 *   counties (its boroughs), London 30+ — carries `wof:parent_id = -4`, so the parent_id closure
 *   dead-ends and the place gets NO region/county/country ancestry. The resolver's region-descendant
 *   filter then can't reach it: given "New York, NY", NYC (with no NY-state ancestor) is excluded and
 *   a correctly-parented namesake ("New York Mills", pop 3,190) wins over NYC's 8.8M. The same defect
 *   orphans London, Singapore, and ~2,850 other localities — the most demo-visible queries.
 *
 *   The authoritative hierarchy IS in the source geojson: `wof:hierarchy` is an array of branches,
 *   each a `<placetype>_id` → id map (region_id, county_id, country_id, …), fully populated even when
 *   parent_id is -4. This reads it for every only-self place and inserts the missing ancestor rows
 *   (one per distinct ancestor across branches).
 *
 *   MUST run AFTER populateAncestors and BEFORE the build freezes (VACUUM INTO), so the rows land in
 *   the shipped artifact — `scripts/build-unified-wof.ts` Phase 3 calls it inline. The standalone
 *   `scripts/backfill-ancestors-from-hierarchy.ts` is a thin CLI over the same function for ad-hoc
 *   repair of an already-built DB. Idempotent: only touches places with <= 1 ancestor row (self), and
 *   inserts each (id, ancestor_id) at most once.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"

/** Genuinely top-level placetypes — they never have (or need) an ancestor, so skip them. */
const TOP_PLACETYPES = new Set(["country", "continent", "empire", "ocean", "marinearea", "planet"])

export interface AncestryBackfillResult {
	/** Places that gained at least one ancestor row. */
	placesFixed: number
	/** Total ancestor rows inserted. */
	rowsAdded: number
	/**
	 * Only-self candidates whose source geojson could not be found (non-WOF backfilled places, or repos not present
	 * locally) — skipped, not an error.
	 */
	noGeojson: number
}

/**
 * Discover the `data` directories under a WOF repos root that hold sharded geojson, e.g.
 * `<root>/whosonfirst-data/whosonfirst-data-admin-us/data`. Resolves an id to its geojson via these roots. Accepts both
 * the nested lab layout (a `whosonfirst-data` group dir holding the admin repos) and a flat layout (admin repos
 * directly under the root); searches at most two directory levels deep.
 */
export function discoverAdminDataRoots(reposRoot: string): string[] {
	const roots: string[] = []

	const visit = (dir: string, depth: number): void => {
		if (depth > 2) return

		let names: string[]

		try {
			names = readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
		} catch {
			return
		}

		for (const name of names) {
			const child = join(dir, name)

			if (name === "data") {
				roots.push(child)
			} else if (name.startsWith("whosonfirst-data")) {
				visit(child, depth + 1)
			}
		}
	}

	visit(reposRoot, 0)

	return roots
}

/** WOF geojson lives sharded: an id resolves to `<3-char chunks>/<id>.geojson` under each data root. */
function geojsonForID(id: number, roots: readonly string[]): Record<string, unknown> | null {
	const s = String(id)
	const chunks: string[] = []

	for (let i = 0; i < s.length; i += 3) chunks.push(s.slice(i, i + 3))
	const rel = join(chunks.join("/"), `${s}.geojson`)

	for (const root of roots) {
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

// `<placetype>_id` key → ancestor placetype. WOF hierarchy keys are e.g. region_id, county_id. Self
// is filtered downstream by the `aid === id` check, so we do NOT special-case locality here: for a
// locality candidate `locality_id` IS self (dropped by aid===id), but for a neighbourhood candidate
// `locality_id` is its PARENT locality — a real ancestor we must keep.
function placetypeFromKey(key: string): string | null {
	if (!key.endsWith("_id")) return null

	return key.slice(0, -3)
}

/**
 * Insert missing ancestor rows for only-self places by reading `wof:hierarchy` from their source geojson under
 * `geojsonRoots` (see {@link discoverAdminDataRoots}). Runs inside a single transaction; caller owns connection
 * lifecycle (open, WAL checkpoint, close).
 */
export function backfillAncestorsFromHierarchy(
	db: DatabaseSync,
	geojsonRoots: readonly string[]
): AncestryBackfillResult {
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
		if (TOP_PLACETYPES.has(placetype)) continue
		const gj = geojsonForID(id, geojsonRoots)
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

	return { placesFixed, rowsAdded, noGeojson }
}
