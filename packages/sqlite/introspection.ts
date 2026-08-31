/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Questions asked of `sqlite_master`.
 */

import type { DatabaseClient } from "#client"

/**
 * Whether a TABLE named `name` exists. An index, view or trigger of that name answers `false`.
 */
export function tableExists<DB>(db: DatabaseClient<DB>, name: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

/**
 * `COUNT(*)` over `table`. The name is interpolated, so it must come from the schema, never from input.
 */
export function countRows<DB>(db: DatabaseClient<DB>, table: string): number {
	const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined

	return Number(row?.n ?? 0)
}
