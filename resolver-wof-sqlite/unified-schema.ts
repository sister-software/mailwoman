/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Schema for the unified WOF SQLite database we build from cloned WOF GeoJSON repos
 *   (`scripts/build-unified-wof.ts`). This is the CANONICAL gazetteer — we never use the
 *   off-the-shelf geocode.earth prebuilt dumps (they assign different WOF ids to the same place;
 *   see the `feedback-custom-wof-db-only` memory). The table/column names match the resolver's
 *   expectations (`lookup.ts`) so `WofSqlitePlaceLookup` works unchanged, INCLUDING the `ancestors`
 *   table (which lookup.ts's parent-constraint subquery needs) — see `populateAncestors`. The
 *   `place_search` FTS5 + `place_bbox` R*Tree are built separately by `build-fts` (fts.ts).
 */

import { DatabaseSync } from "node:sqlite"

export function createUnifiedSchema(db: DatabaseSync): void {
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA busy_timeout = 10000")
	db.exec("PRAGMA synchronous = OFF")

	db.exec(`
		CREATE TABLE IF NOT EXISTS spr (
			id INTEGER PRIMARY KEY,
			parent_id INTEGER NOT NULL DEFAULT -1,
			name TEXT NOT NULL DEFAULT '',
			placetype TEXT NOT NULL DEFAULT '',
			country TEXT NOT NULL DEFAULT '',
			latitude REAL NOT NULL DEFAULT 0,
			longitude REAL NOT NULL DEFAULT 0,
			min_latitude REAL NOT NULL DEFAULT 0,
			min_longitude REAL NOT NULL DEFAULT 0,
			max_latitude REAL NOT NULL DEFAULT 0,
			max_longitude REAL NOT NULL DEFAULT 0,
			is_current INTEGER NOT NULL DEFAULT 1,
			is_deprecated INTEGER NOT NULL DEFAULT 0,
			is_ceased INTEGER NOT NULL DEFAULT 0,
			is_superseded INTEGER NOT NULL DEFAULT 0,
			is_superseding INTEGER NOT NULL DEFAULT 0,
			lastmodified INTEGER NOT NULL DEFAULT 0
		)
	`)

	db.exec(`
		CREATE TABLE IF NOT EXISTS names (
			id INTEGER NOT NULL,
			name TEXT NOT NULL,
			placetype TEXT NOT NULL DEFAULT '',
			country TEXT NOT NULL DEFAULT '',
			language TEXT NOT NULL DEFAULT '',
			privateuse TEXT NOT NULL DEFAULT '',
			lastmodified INTEGER NOT NULL DEFAULT 0
		)
	`)

	db.exec(`
		CREATE TABLE IF NOT EXISTS concordances (
			id INTEGER NOT NULL,
			other_id TEXT NOT NULL,
			other_source TEXT NOT NULL,
			lastmodified INTEGER NOT NULL DEFAULT 0
		)
	`)

	db.exec(`
		CREATE TABLE IF NOT EXISTS place_population (
			id INTEGER PRIMARY KEY,
			population INTEGER NOT NULL DEFAULT 0
		)
	`)

	// `ancestors` maps each place to every place above it in the hierarchy (and itself). The
	// resolver's parent-constraint scopes a child lookup to a parent's descendants via
	// `spr.id IN (SELECT id FROM ancestors WHERE ancestor_id = ?)`. The off-the-shelf WOF dumps
	// ship this table; our build derives it from the parent_id chain (see populateAncestors) since
	// we don't capture `wof:hierarchy`.
	db.exec(`
		CREATE TABLE IF NOT EXISTS ancestors (
			id INTEGER NOT NULL,
			ancestor_id INTEGER NOT NULL,
			ancestor_placetype TEXT NOT NULL DEFAULT '',
			lastmodified INTEGER NOT NULL DEFAULT 0
		)
	`)
}

/**
 * Populate the `ancestors` table by walking each place's `parent_id` chain in `spr` (transitive
 * closure, including the place itself). Idempotent: drops + rebuilds the table contents. Returns the
 * row count. Run after `spr` is fully ingested (build-unified-wof freeze phase) or standalone on an
 * existing unified DB (`scripts/add-ancestors.ts`). Sentinel/negative parent_ids and cycles
 * terminate the walk. ~4 rows/place average; a transaction keeps the ~5M inserts fast.
 */
export function populateAncestors(db: DatabaseSync): number {
	db.exec("DELETE FROM ancestors")
	const rows = db.prepare("SELECT id, parent_id, placetype FROM spr").all() as Array<{
		id: number
		parent_id: number
		placetype: string
	}>
	const byId = new Map<number, { parent: number; placetype: string }>()
	for (const r of rows) byId.set(r.id, { parent: r.parent_id, placetype: r.placetype })

	const insert = db.prepare("INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)")
	db.exec("BEGIN")
	let count = 0
	for (const r of rows) {
		insert.run(r.id, r.id, r.placetype) // self
		count++
		const seen = new Set<number>([r.id])
		let cur = r.parent_id
		while (cur > 0 && !seen.has(cur)) {
			const node = byId.get(cur)
			if (!node) break
			insert.run(r.id, cur, node.placetype)
			count++
			seen.add(cur)
			cur = node.parent
		}
	}
	db.exec("COMMIT")
	return count
}

export function createUnifiedIndexes(db: DatabaseSync): void {
	db.exec("CREATE INDEX IF NOT EXISTS spr_by_placetype ON spr (placetype)")
	db.exec("CREATE INDEX IF NOT EXISTS spr_by_country ON spr (country)")
	db.exec("CREATE INDEX IF NOT EXISTS spr_by_parent ON spr (parent_id)")
	db.exec("CREATE INDEX IF NOT EXISTS names_by_id ON names (id)")
	db.exec("CREATE INDEX IF NOT EXISTS names_by_name ON names (name)")
	db.exec("CREATE INDEX IF NOT EXISTS concordances_by_id ON concordances (id, lastmodified)")
	db.exec("CREATE INDEX IF NOT EXISTS concordances_by_other_id ON concordances (other_source, other_id)")
	// ancestor_id is the hot column (parent-constraint queries `WHERE ancestor_id = ?`); id supports
	// the reverse lookup.
	db.exec("CREATE INDEX IF NOT EXISTS ancestors_by_ancestor ON ancestors (ancestor_id)")
	db.exec("CREATE INDEX IF NOT EXISTS ancestors_by_id ON ancestors (id)")
}
