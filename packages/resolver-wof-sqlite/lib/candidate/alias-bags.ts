// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Pass 2 of the candidate build: explode `place_search.alt_names` into distinct alias rows.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"

import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import type { CandidateDatabase } from "#candidate/schema"
import { ALIAS_SEPARATOR } from "#fts"
import type { WOFDatabase } from "#schema"
import { type NameKey, normalizeLocalityForKey, withoutApostropheLikeMarks } from "#street/normalize"

/**
 * The official name of every current region, keyed `${country id}\0${name key}` →
 * region id, from the source `names` table's `official` bit.
 *
 * Empty when the source has no `names` table (a fixture, or an extract shape).
 *
 * The positive evidence behind the alias refusal below: a name is refused from a region's
 * bag only when another region of the same country holds it as its official name.
 */
function officialNameHoldersByRegion(
	src: DatabaseClient<WOFDatabase>,
	ccID: (code: string | null) => number
): Map<string, number> {
	const keys = new Map<string, number>()

	if (!tableExists(src, "names")) return keys

	for (const r of src
		.prepare(
			`SELECT n.id AS id, n.name AS name, s.country AS country
			 FROM names n JOIN spr s ON s.id = n.id
			 WHERE s.placetype = 'region' AND s.is_current != 0 AND s.is_deprecated = 0 AND n.official = 1`
		)
		.iterate()) {
		const k = normalizeLocalityForKey(String(r.name ?? ""))

		if (k) {
			keys.set(`${ccID(r.country as string | null)}\0${k}`, Number(r.id))
		}
	}

	return keys
}

/**
 * Pass 2: explode each place's `place_search.alt_names` bag into distinct-key alias rows
 * (`is_primary = 0`), and count each place's distinct staged keys with the primary included.
 *
 * With `regionPlacetypeID` and `ccID` given, a region's alias that's another same-country region's
 * official name is refused and counted rather than staged (see {@link officialNameHoldersByRegion}).
 * Without them the pass stages every alias.
 *
 * Each key holding an apostrophe-like mark, the primary's included, also stages
 * its mark-free form ({@link withoutApostropheLikeMarks}).
 * The count excludes those forms.
 *
 * The gloss detector compares the count with its threshold, and a mark-free form
 * spells a name the count already includes.
 */
export function explodeAliasBags(
	src: DatabaseClient<WOFDatabase>,
	out: DatabaseClient<CandidateDatabase>,
	attrs: Map<number, PlaceAttrs>,
	stageRow: StageRow,
	opts: {
		regionPlacetypeID?: number
		ccID?: (code: string | null) => number
		/**
		 * The bare form of an alias in its place's country, staged as one more alias: `渋谷` for the alias `渋谷区`.
		 *
		 * A Japanese place's primary name is romanized, so its suffixed name reaches
		 * the candidate only as an alias.
		 */
		bareName?: (countryID: number, alias: string) => string | null
	} = {}
): {
	nAlias: number
	nBare: number
	nMarkFree: number
	keyCounts: Map<number, number>
	regionOfficialRefused: number
} {
	let nAlias = 0
	let nBare = 0
	let nMarkFree = 0
	let regionOfficialRefused = 0
	const keyCounts = new Map<number, number>()

	const official =
		typeof opts.regionPlacetypeID === "number" && opts.ccID
			? officialNameHoldersByRegion(src, opts.ccID)
			: new Map<string, number>()

	out.exec("BEGIN")

	for (const r of src.prepare("SELECT wof_id, alt_names FROM place_search").iterate()) {
		const id = Number(r.wof_id)
		const a = attrs.get(id)
		const alt = r.alt_names as string | null

		if (!a) continue
		const seen = new Set<string>([a.pkey])
		const markFree = new Set<string>()
		const isRegion = a.ptid === opts.regionPlacetypeID

		const refused = (k: string): boolean => {
			if (!isRegion) return false
			const holder = official.get(`${a.cid}\0${k}`)

			return typeof holder === "number" && holder !== id
		}

		// Returns 1 when it staged a row, so the caller adds the result to the count.
		const stageMarkFree = (k: NameKey): number => {
			const free = withoutApostropheLikeMarks(k)

			if (!free || free === k || seen.has(free) || markFree.has(free) || refused(free)) return 0
			markFree.add(free)
			stageRow(free, a, id, 0)

			return 1
		}

		nMarkFree += stageMarkFree(a.pkey as NameKey)

		// The writer space-pads each separator and appends a trailing one, so every piece
		// includes surrounding whitespace and the last one is empty.
		// `normalizeLocalityForKey` folds both away.
		for (const piece of alt?.split(ALIAS_SEPARATOR) ?? []) {
			const bare = opts.bareName?.(a.cid, piece.trim())
			const keys = [normalizeLocalityForKey(piece), bare ? normalizeLocalityForKey(bare) : ""]

			for (const [position, k] of keys.entries()) {
				if (!k || seen.has(k)) continue
				seen.add(k)

				if (refused(k)) {
					regionOfficialRefused++

					continue
				}

				// A mark-free form staged earlier now arrives as a name of its own, so it counts as one.
				if (markFree.delete(k)) {
					nMarkFree--
				} else {
					stageRow(k, a, id, 0)
				}

				if (position) {
					nBare++
				} else {
					nAlias++
				}

				nMarkFree += stageMarkFree(k as NameKey)
			}
		}

		if (alt) {
			keyCounts.set(id, seen.size)
		}
	}

	out.exec("COMMIT")

	return { nAlias, nBare, nMarkFree, keyCounts, regionOfficialRefused }
}
