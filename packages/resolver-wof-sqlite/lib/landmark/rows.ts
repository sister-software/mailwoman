// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The landmark table's read, shared by the native lookup and the range-read lookup a Worker uses. It holds no database
 *   client, so a Worker bundle can import it.
 */

import type { LandmarkHit, LandmarkKind } from "@mailwoman/core/resolver"

import { normalizeLocalityForKey } from "#street/normalize"

/**
 * One way of writing one place.
 */
export interface LandmarkNameTable {
	name_key: string
	qid: string
	/**
	 * The place's own display name.
	 */
	name: string
	kind: LandmarkKind
	country: string | null
	latitude: number
	longitude: number
	sitelinks: number
	/**
	 * The upper-case spelling of a code alias such as `DTW`, or `null` for an ordinary name.
	 *
	 * A code answers only when written in that case, so `Lax` and `Sea` stay words.
	 */
	code: string | null
	/**
	 * 1 when this is the place's own name in English or its country's language, 0 for a translation or alias.
	 */
	is_primary: number
	/**
	 * The importance Photon's index holds for an OpenStreetMap place, or `null` for a Wikidata place.
	 */
	importance: number | null
	/**
	 * The place's short H3 cell, the spatial key an OpenStreetMap layer's manifest names,
	 * or `null` for a Wikidata place.
	 */
	h3_cell: number | null
}

/**
 * The read of every row under one name key, best first.
 */
export const LANDMARK_BY_NAME_SQL =
	"SELECT * FROM landmark_name WHERE name_key = ? ORDER BY is_primary DESC, sitelinks DESC, importance DESC, qid"

/**
 * Returns the key a written name is stored and read under.
 *
 * Canonical Unicode form, a typographic apostrophe and a sentence's closing period do not change
 * which place a name means, so `St George’s.` and `St George's` read one row.
 */
export function landmarkNameKey(written: string): string {
	return normalizeLocalityForKey(written.normalize("NFC").replaceAll("’", "'").trim().replace(/\.+$/u, ""))
}

/**
 * Turns the rows under a name's key into hits for that name as it was written.
 *
 * A code written in its own case is an identifier, so it ranks ahead of every word spelled the same.
 * A code row reads only in that case.
 */
export function landmarkHitsFromRows(rows: readonly LandmarkNameTable[], name: string): LandmarkHit[] {
	const written = name.trim()
	const isCode = (row: LandmarkNameTable) => row.code === written

	return rows
		.filter((row) => !row.code || isCode(row))
		.toSorted((a, b) => Number(isCode(b)) - Number(isCode(a)))
		.map((row) => ({
			code: isCode(row),
			qid: row.qid,
			name: row.name,
			kind: row.kind,
			country: row.country,
			lat: row.latitude,
			lon: row.longitude,
			sitelinks: row.sitelinks,
			primary: row.is_primary === 1,
			importance: row.importance ?? null,
		}))
}
