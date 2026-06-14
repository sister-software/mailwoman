/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Small shared helpers for the SQLite-backed lookups.
 */

import type { DatabaseSync } from "node:sqlite"

/**
 * True when `name` is a table in the open database. The street-level lookups use this to degrade
 * gracefully on an empty/tableless shard — an interrupted `build-*-shard.ts`, or a stray 0-byte
 * file (e.g. `sqlite3 <missing>.db "…"` CREATES one) — rather than throwing `no such table` at
 * construction and taking down a whole state's geocode (#568). A missing table makes the lookup a
 * no-op miss.
 */
export function hasTable(db: DatabaseSync, name: string): boolean {
	try {
		const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name)
		return row !== undefined
	} catch {
		return false
	}
}
