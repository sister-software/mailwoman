/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The exact-match tier's name probes — the two case-folded equality lookups that decide whether a
 *   candidate holds the query text as its own name, an alias, or an official name.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { aliasBagExactMatch, foldQueryText } from "#fts/index"

/**
 * Among `ids`, return the subset whose name OR any alias equals `text` case-insensitively — the exact-match tier for
 * ranking. One indexed query over `<schema>.names`. When the extract has no `names` table (a slim DB built with
 * `dropNames`, or a postcode-only extract), fall back to the self-contained `place_search` FTS content: its `alt_names`
 * column is the same alias set joined on the boundary-preserving `ALIAS_SEPARATOR` (#523), so `aliasBagExactMatch`
 * recovers the exact alias tier ("New York City" → New York) that the dropped `names` table used to provide.
 */
export function exactMatchIDs<DB>(
	db: DatabaseClient<DB>,
	schemaName: string,
	ids: number[],
	text: string
): Set<number> {
	const out = new Set<number>()
	const trimmed = text.trim()

	if (!ids.length || !trimmed) return out
	const placeholders = ids.map(() => "?").join(", ")

	try {
		const rows = db
			.prepare(`SELECT DISTINCT id FROM ${schemaName}.names WHERE id IN (${placeholders}) AND name = ? COLLATE NOCASE`)
			.all(...ids, trimmed) as Array<{ id: number }>

		for (const r of rows) {
			out.add(r.id)
		}

		return out
	} catch {
		// No `names` table on this extract — fall through to the place_search alias bag.
	}

	try {
		const rows = db
			.prepare(`SELECT wof_id AS id, name, alt_names FROM ${schemaName}.place_search WHERE wof_id IN (${placeholders})`)
			.all(...ids) as Array<{ id: number; name: string | null; alt_names: string | null }>

		const needle = foldQueryText(trimmed)

		for (const r of rows) {
			if (r.name !== null && foldQueryText(r.name) === needle) {
				out.add(r.id)
			}
		}

		// Alias pass via the shared bag parser (#523). Separated bags (built since #523) get a true
		// per-alias equality check, ungated — matching the `names`-table branch above, where an
		// alias match counts as exact regardless of other candidates. Legacy bags (no separator)
		// fall back to padded containment, gated on "no canonical exact in the pool" because their
		// lost boundaries would otherwise false-promote interior fragments ("York" inside the alias
		// "New York City") or cross-alias fragments ("York New" across "…York" + "New City…").
		const anyCanonicalExact = out.size > 0

		for (const r of rows) {
			if (aliasBagExactMatch(r.alt_names, needle, anyCanonicalExact)) {
				out.add(r.id)
			}
		}
	} catch {
		// Extract without place_search either → no exact-match tier. Falls back to weighted-sum order.
	}

	return out
}

/**
 * Among `ids` (already known exact matches), the subset holding `text` as an OFFICIAL name (`names.official = 1`, the
 * #940 ingest bit). Same COLLATE NOCASE semantics as {@link WOFSQLitePlaceLookup.#exactMatchIDs} so the two probes
 * agree on what "equals the query" means. Fails soft on gazetteers built before #940 (no `official` column) — the
 * sub-tier then behaves exactly as if `officialNameExact` were off.
 */
export function officialNameIDs<DB>(
	db: DatabaseClient<DB>,
	schemaName: string,
	ids: number[],
	text: string
): Set<number> {
	const out = new Set<number>()
	const trimmed = text.trim()

	if (!ids.length || !trimmed) return out
	const placeholders = ids.map(() => "?").join(", ")

	try {
		const rows = db
			.prepare(
				`SELECT DISTINCT id FROM ${schemaName}.names WHERE id IN (${placeholders}) AND official = 1 AND name = ? COLLATE NOCASE`
			)
			.all(...ids, trimmed) as Array<{ id: number }>

		for (const r of rows) {
			out.add(r.id)
		}
	} catch {
		// Pre-#940 gazetteer (no `official` column) or a names-less slim extract — feature inert.
	}

	return out
}
