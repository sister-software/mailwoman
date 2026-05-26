/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Schema for the unified WOF SQLite database produced by wof/prepare --unified-db.
 *   Matches geocode.earth conventions so the FST builder and resolver work unchanged.
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
}

export function createUnifiedIndexes(db: DatabaseSync): void {
	db.exec("CREATE INDEX IF NOT EXISTS spr_by_placetype ON spr (placetype)")
	db.exec("CREATE INDEX IF NOT EXISTS spr_by_country ON spr (country)")
	db.exec("CREATE INDEX IF NOT EXISTS spr_by_parent ON spr (parent_id)")
	db.exec("CREATE INDEX IF NOT EXISTS names_by_id ON names (id)")
	db.exec("CREATE INDEX IF NOT EXISTS names_by_name ON names (name)")
	db.exec("CREATE INDEX IF NOT EXISTS concordances_by_id ON concordances (id, lastmodified)")
	db.exec("CREATE INDEX IF NOT EXISTS concordances_by_other_id ON concordances (other_source, other_id)")
}
