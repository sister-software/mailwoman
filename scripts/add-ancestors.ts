/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One-shot: add + populate the `ancestors` table on an EXISTING unified WOF DB, so we don't have to
 *   re-run the full build just to get the table the resolver's parent-constraint needs. New builds
 *   already produce `ancestors` (build-unified-wof.ts freeze phase). Uses the same
 *   `populateAncestors` (parent_id closure) as the build — one source of truth.
 *
 *   We NEVER use the off-the-shelf geocode.earth dumps (which ship `ancestors`); the canonical DB is
 *   our custom build. See the `feedback-custom-wof-db-only` memory.
 *
 *   Usage: node --experimental-strip-types scripts/add-ancestors.ts [/path/to/unified.db] (compile
 * @mailwoman/resolver-wof-sqlite first so the import resolves to the updated out/)
 */

import {
	createUnifiedIndexes,
	createUnifiedSchema,
	populateAncestors,
} from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { DatabaseSync } from "node:sqlite"

const dbPath = process.argv[2] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
console.error(`Adding ancestors to ${dbPath} ...`)
const db = new DatabaseSync(dbPath)
createUnifiedSchema(db) // CREATE TABLE IF NOT EXISTS — adds `ancestors`, leaves existing tables intact
const t0 = performance.now()
const rows = populateAncestors(db)
createUnifiedIndexes(db)
db.exec("ANALYZE")
// Restore the frozen single-file state (createUnifiedSchema put us in WAL).
db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
db.exec("PRAGMA journal_mode = DELETE")
db.close()
console.error(`ancestors: ${rows} rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
