/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Thin CLI over {@link backfillAncestorsFromHierarchy} (@mailwoman/resolver-wof-sqlite) for ad-hoc
 *   repair of an ALREADY-BUILT unified WOF DB. The build pipeline (`scripts/build-unified-wof.ts`,
 *   Phase 3) now calls the same function inline AFTER populateAncestors and BEFORE the freeze, so a
 *   fresh rebuild needs no separate step — this CLI exists for repairing a DB built before the wiring
 *   landed, or for re-running after a manual ancestors edit.
 *
 *   Repairs only-self ancestry left by the parent_id closure for places whose `wof:parent_id` is the
 *   WOF `-4` "multi-parent" sentinel (New York City, London, …) — see the function's docstring for the
 *   root cause (#440 / #832). Idempotent.
 *
 *   Run AFTER build-unified-wof and add-region-abbrevs, BEFORE build-fts (FTS doesn't depend on
 *   ancestors, so order vs FTS is not strict):
 *
 *     node --experimental-strip-types scripts/backfill-ancestors-from-hierarchy.ts <unified.db> [<repos-root>]
 *
 *   <repos-root> defaults to the lab WOF repos dir; its `whosonfirst-data` admin-repo `data` subtrees
 *   are discovered automatically (no hardcoded admin list).
 */

import { DatabaseSync } from "node:sqlite"

import {
	backfillAncestorsFromHierarchy,
	discoverAdminDataRoots,
} from "@mailwoman/resolver-wof-sqlite/ancestry-backfill"

const dbPath = process.argv[2] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
const reposRoot = process.argv[3] ?? "/mnt/playpen/mailwoman-data/wof/repos"

const geojsonRoots = discoverAdminDataRoots(reposRoot)

if (geojsonRoots.length === 0) {
	console.error(`No */data geojson roots found under ${reposRoot} — nothing to read hierarchy from.`)
	process.exit(1)
}

console.error(`Reading hierarchy from ${geojsonRoots.length} data root(s) under ${reposRoot}`)

const db = new DatabaseSync(dbPath)
const { placesFixed, rowsAdded, noGeojson } = backfillAncestorsFromHierarchy(db, geojsonRoots)

db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
db.close()

console.error(
	`backfilled ancestry for ${placesFixed} places (+${rowsAdded} rows); ${noGeojson} candidates had no source geojson`
)
