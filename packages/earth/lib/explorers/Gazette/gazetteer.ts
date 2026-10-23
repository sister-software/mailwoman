/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The gazette explorer's reads over the published browser gazetteer, `candidate.db`, through the same
 *   byte-range worker the geocoder uses and without the classifier. Every query is a primary-key probe or a
 *   primary-key range, except the "contains" search. That one asks the trigram FTS index.
 */

import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import type { RangeDatabase } from "@mailwoman/resolver-wof-wasm/httpvfs/database"
import type { SQLValue } from "@mailwoman/resolver-wof-wasm/httpvfs/worker-protocol"
import { adminGazetteerURL } from "mailwoman/browser-runtime/resources"

import {
	type GazetteerCodes,
	groupByNameKey,
	type NameGroup,
	PLACE_COLUMNS,
	type PlaceRow,
	prefixUpperBound,
	rowFromRecord,
} from "./helpers.ts"

export interface Gazetteer {
	database: RangeDatabase
	codes: GazetteerCodes
	/**
	 * The layer manifest's version string, such as `2026-08-25`.
	 */
	version: string
}

/**
 * The count of candidate rows a prefix search reads.
 *
 * Rows are about a hundred bytes, so this is one or two range chunks, and a prefix such
 * as `londo` covers 61 distinct keys in its first 200 rows on the 2026-08-25b generation.
 */
const PREFIX_ROW_LIMIT = 400

/**
 * The count of keys the "contains" search asks the trigram index for.
 */
const CONTAINS_KEY_LIMIT = 24

/**
 * The run length the trigram tokenizer indexes, so a "contains" search starts at this length.
 */
const TRIGRAM_LENGTH = 3

/**
 * The count of places read under one key.
 *
 * A key with more places, such as `london` with 57, reports this count
 * and the page marks the total as a floor.
 */
export const NAMED_ROW_LIMIT = 50

/**
 * Opens the browser gazetteer by byte ranges and reads its two code tables and manifest.
 */
export async function openGazetteer(sqliteRuntimeBaseURL: string): Promise<Gazetteer> {
	const { openRangeDatabase } = await import("@mailwoman/resolver-wof-wasm/httpvfs/database")
	const database = await openRangeDatabase(adminGazetteerURL(), sqliteRuntimeBaseURL)

	const [countries, placetypes, manifest] = await Promise.all([
		database.query<{ id: number; code: string }>("SELECT id, code FROM country_codes"),
		database.query<{ id: number; placetype: string }>("SELECT id, placetype FROM placetype_codes"),
		database.query<{ version: string }>("SELECT version FROM layer_manifest WHERE name = 'candidate'"),
	])

	return {
		database,
		codes: {
			countries: new Map(countries.map((row) => [row.id, row.code])),
			placetypes: new Map(placetypes.map((row) => [row.id, row.placetype])),
		},
		version: manifest[0]?.version ?? "unknown",
	}
}

/**
 * The name key the resolver would probe for `text`, or null for blank input.
 */
export function nameKeyOf(text: string): string | null {
	const key = normalizeLocalityForKey(text.trim())

	return key ? String(key) : null
}

async function placeRows(gazetteer: Gazetteer, where: string, parameters: readonly SQLValue[]): Promise<PlaceRow[]> {
	const records = await gazetteer.database.query<Record<string, SQLValue>>(
		`SELECT ${PLACE_COLUMNS} FROM candidate WHERE ${where}`,
		parameters
	)

	return records.map((record) => rowFromRecord(record, gazetteer.codes))
}

/**
 * The places whose key starts with the fold of `text`, grouped by key in key order.
 *
 * A key equal to the fold itself is listed first.
 */
export async function searchByPrefix(gazetteer: Gazetteer, text: string): Promise<NameGroup[]> {
	const key = nameKeyOf(text)

	if (!key) return []

	const rows = await placeRows(gazetteer, "name_key >= ? AND name_key < ? ORDER BY name_key LIMIT ?", [
		key,
		prefixUpperBound(key),
		PREFIX_ROW_LIMIT,
	])

	const groups = groupByNameKey(rows)
	const exact = groups.findIndex((group) => group.nameKey === key)

	if (exact > 0) {
		const [group] = groups.splice(exact, 1)

		groups.unshift(group!)
	}

	return groups
}

/**
 * The keys that contain the fold of `text` anywhere, from the trigram index, each with its strongest place.
 *
 * The trigram tokenizer indexes runs of three characters, so the search starts at a three-character key.
 */
export async function searchContaining(gazetteer: Gazetteer, text: string): Promise<NameGroup[]> {
	const key = nameKeyOf(text)

	if (!key || key.length < TRIGRAM_LENGTH) return []

	// The key is quoted as one FTS5 string so its spaces and punctuation read as text.
	const matches = await gazetteer.database.query<{ name_key: string }>(
		"SELECT name_key FROM candidate_fts WHERE candidate_fts MATCH ? LIMIT ?",
		[`"${key.replaceAll('"', '""')}"`, CONTAINS_KEY_LIMIT]
	)

	const groups = await Promise.all(
		matches.map(async (match) => {
			const rows = await placesNamed(gazetteer, match.name_key)

			return groupByNameKey(rows)[0] ?? null
		})
	)

	return groups.filter((group): group is NameGroup => group !== null)
}

/**
 * Every place under one key, strongest first.
 */
export function placesNamed(gazetteer: Gazetteer, nameKey: string): Promise<PlaceRow[]> {
	return placeRows(gazetteer, "name_key = ? ORDER BY neg_rank ASC LIMIT ?", [nameKey, NAMED_ROW_LIMIT])
}

/**
 * One place by its id under the key it is filed under, or null when the key holds no such place.
 */
export async function placeByRef(gazetteer: Gazetteer, sprID: number, nameKey: string): Promise<PlaceRow | null> {
	const rows = await placeRows(gazetteer, "name_key = ? AND spr_id = ? LIMIT 1", [nameKey, sprID])

	return rows[0] ?? null
}

export interface Ancestor {
	depth: number
	sprID: number
	placetype: string
	name: string
	nameKey: string
}

/**
 * The ancestors of a place from its parent upward, each linkable through its own key.
 */
export async function ancestorsOf(gazetteer: Gazetteer, sprID: number): Promise<Ancestor[]> {
	const rows = await gazetteer.database.query<{
		depth: number
		parent_spr_id: number
		parent_placetype_id: number
		parent_name: string
		parent_name_key: string
	}>(
		"SELECT depth, parent_spr_id, parent_placetype_id, parent_name, parent_name_key FROM candidate_ancestor WHERE spr_id = ? ORDER BY depth",
		[sprID]
	)

	return rows.map((row) => ({
		depth: row.depth,
		sprID: row.parent_spr_id,
		placetype: gazetteer.codes.placetypes.get(row.parent_placetype_id) ?? `#${row.parent_placetype_id}`,
		name: row.parent_name,
		nameKey: row.parent_name_key,
	}))
}
