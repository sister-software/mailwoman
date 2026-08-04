/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Repair the truncated ancestry that {@link populateAncestors} (the parent_id closure in
 *   unified-schema.ts) leaves wherever the closure dead-ends before reaching the top.
 *
 *   Root cause (#440 / #832): a place that straddles multiple parents — New York City spans five
 *   counties (its boroughs), London 30+ — carries `wof:parent_id = -4`, so the parent_id closure
 *   dead-ends and the place gets NO region/county/country ancestry. The resolver's region-descendant
 *   filter then can't reach it: given "New York, NY", NYC (with no NY-state ancestor) is excluded and
 *   a correctly-parented namesake ("New York Mills", pop 3,190) wins over NYC's 8.8M. The same defect
 *   orphans London, Singapore, and ~2,850 other localities — the most demo-visible queries.
 *
 *   **The dead end is inherited by children (#1445).** Repairing the `-4` place itself does not repair
 *   anything BELOW it: the closure walks Brooklyn → New York and stops, because New York's own
 *   `parent_id` is `-4`. Brooklyn-the-borough (pop 2.5M) therefore carried exactly two ancestor rows —
 *   itself and New York — with no county, region or country, and the only US locality-tier place named
 *   "Brooklyn" that survived a New-York-State descendant filter was Pillar Point, a Jefferson County
 *   hamlet 411 km away carrying "Brooklyn" as an alternate name. All five NYC boroughs, every London
 *   borough and Hyderabad's zones were in the same state.
 *
 *   So the candidate test is NOT "has only a self ancestor" — that misses every child of a repaired
 *   place, which by construction has two. It is **"has no `country`-tier ancestor"**. Country is the
 *   universal terminal for every non-{@link TOP_PLACETYPES} placetype, so its absence is exactly the
 *   signal that the chain dead-ended somewhere, at whatever depth. On a wide-coverage build this
 *   selects ~24k places against 2.55M rows.
 *
 *   A place whose `wof:hierarchy` genuinely stops short is NOT a candidate and needs no repair: the
 *   source is the authority on what a place should have. American Samoa's localities, for instance,
 *   have `{country_id, locality_id}` and no region in WOF itself — the artifact matching that is
 *   correct, not truncated.
 *
 *   The authoritative hierarchy IS in the source geojson: `wof:hierarchy` is an array of branches,
 *   each a `<placetype>_id` → id map (region_id, county_id, country_id, …), fully populated even when
 *   parent_id is -4. This reads it for every candidate and inserts the missing ancestor rows (one per
 *   distinct ancestor across branches).
 *
 *   MUST run AFTER populateAncestors and BEFORE the build freezes (VACUUM INTO), so the rows land in
 *   the shipped artifact — `scripts/build-unified-wof.ts` Phase 3 calls it inline. The standalone
 *   `scripts/backfill-ancestors-from-hierarchy.ts` is a thin CLI over the same function for ad-hoc
 *   repair of an already-built DB. Idempotent by the per-pair existence check, not by the candidate
 *   test: each (id, ancestor_id) is inserted at most once, so a second run over the same DB adds
 *   nothing.
 */

import { readdirSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readWOFFeature } from "@mailwoman/core/resources/whosonfirst"
import { join } from "path-ts"

import type { WOFDatabase } from "./schema.ts"

/**
 * Genuinely top-level placetypes — they never have (or need) an ancestor, so skip them.
 */
const TOP_PLACETYPES = new Set(["country", "continent", "empire", "ocean", "marinearea", "planet"])

export interface AncestryBackfillResult {
	/**
	 * Places that gained at least one ancestor row.
	 */
	placesFixed: number
	/**
	 * Total ancestor rows inserted.
	 */
	rowsAdded: number
	/**
	 * Candidates whose source geojson could not be found (non-WOF backfilled places, or repos not present locally) —
	 * skipped, not an error.
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

// `<placetype>_id` key → ancestor placetype. WOF hierarchy keys are e.g. region_id, county_id. Self
// is filtered downstream by the `aid === id` check, so we do NOT special-case locality here: for a
// locality candidate `locality_id` IS self (dropped by aid===id), but for a neighbourhood candidate
// `locality_id` is its PARENT locality — a real ancestor we must keep.
function placetypeFromKey(key: string): string | null {
	if (!key.endsWith("_id")) return null

	return key.slice(0, -3)
}

/**
 * Insert missing ancestor rows for every place whose ancestry chain dead-ended before reaching a country, by reading
 * `wof:hierarchy` from its source geojson under `geojsonRoots` (see {@link discoverAdminDataRoots}). Runs inside a
 * single transaction; caller owns connection lifecycle (open, WAL checkpoint, close).
 *
 * `opts.maxID` bounds the candidate scan to ids BELOW it — pass the synthetic-id base (`OVERTURE_ID_BASE`, 8e12) so the
 * backfill considers only real WOF places. Overture/GeoNames rows carry synthetic ids and have NO `wof:hierarchy`
 * geojson, so probing them is pure waste: on a wide-coverage DB the country-less set is millions of Overture/GeoNames
 * leaf localities, and the per-candidate geojson probe across every repo root turns a seconds-long WOF-only pass into a
 * ~40-minute one (their ancestry comes from the parent_id closure, not this backfill). Correctness-preserving — the
 * skipped rows would have `noGeojson`-skipped anyway. Omit `maxID` (default) for the legacy WOF-only DBs.
 */
export async function backfillAncestorsFromHierarchy(
	db: DatabaseSync,
	geojsonRoots: readonly string[],
	opts: { maxID?: number } = {}
): Promise<AncestryBackfillResult> {
	const maxID = opts.maxID ?? Number.MAX_SAFE_INTEGER
	const kdb = new DatabaseClient<WOFDatabase>({ database: db })

	// "No country-tier ancestor" is the dead-end signal at any depth — see the module docstring. The
	// earlier "<= 1 ancestor row" test only caught the dead end's origin, never the children that
	// inherit it (a child of a repaired -4 place has two rows: itself and that parent) (#1445).
	// The id bound is stated first so SQLite prunes by the PK index before the NOT EXISTS runs at all.
	const candidates = await kdb
		.selectFrom("spr")
		.select(["id", "placetype"])
		.where("id", "<", maxID)
		.where((eb) =>
			eb.not(
				eb.exists(
					eb
						.selectFrom("ancestors")
						.select("ancestors.id")
						.whereRef("ancestors.id", "=", "spr.id")
						.where("ancestors.ancestor_placetype", "=", "country")
				)
			)
		)
		.execute()

	// Every candidate's existing ancestors in ONE query rather than an indexed read each. The widened
	// candidate test made that per-candidate read the dominant cost of the pass, and the set is bounded:
	// a candidate reaching this point has a handful of rows at most.
	const alreadyPresent = new Map<number, Set<number>>()

	for (const row of await kdb
		.selectFrom("ancestors")
		.select(["id", "ancestor_id"])
		.where(
			"id",
			"in",
			candidates.map((c) => c.id)
		)
		.execute()) {
		let set = alreadyPresent.get(row.id)

		if (!set) {
			set = new Set()
			alreadyPresent.set(row.id, set)
		}

		set.add(Number(row.ancestor_id))
	}

	const insert = db.prepare(
		"INSERT INTO ancestors (id, ancestor_id, ancestor_placetype, lastmodified) VALUES (?, ?, ?, 0)"
	)

	let placesFixed = 0
	let rowsAdded = 0
	let noGeojson = 0
	db.exec("BEGIN")

	for (const { id, placetype } of candidates) {
		if (placetype && TOP_PLACETYPES.has(placetype)) continue
		const gj = readWOFFeature(id, geojsonRoots)
		const hierarchy = gj?.properties?.["wof:hierarchy"]

		if (!hierarchy || !hierarchy.length) {
			if (!gj) {
				noGeojson++
			}

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

				if (!seen.has(aid)) {
					seen.set(aid, pt)
				}
			}
		}

		let present = alreadyPresent.get(id)

		if (!present) {
			present = new Set()
			alreadyPresent.set(id, present)
		}

		let added = 0

		for (const [aid, pt] of seen) {
			if (present.has(aid)) continue

			insert.run(id, aid, pt)
			present.add(aid)

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
