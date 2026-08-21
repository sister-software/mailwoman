/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 2 of the candidate build — explode `place_search.alt_names` into distinct alias rows.
 */

import type { DatabaseSync } from "node:sqlite"

import { normalizeLocalityForKey } from "../street-normalize.ts"
import type { PlaceAttrs, StageRow } from "./place-attrs.ts"

/**
 * Boundary-preserving alias-bag separator (#523, U+E000).
 *
 * This must stay the codepoint `fts.ts` joined the bag with — it is a private-use codepoint precisely so no real name
 * can carry one, which also means a mismatch yields ONE undivided key per place rather than an error. The writer
 * space-pads each separator and appends a trailing one, so the pieces this split hands back carry surrounding
 * whitespace and the last one is empty; {@link normalizeLocalityForKey} folds both away.
 */
const ALIAS_SEP = "\u{E000}"

/**
 * Pass 2 — explode each place's `place_search.alt_names` bag into distinct-key alias rows (`is_primary = 0`), and count
 * each place's distinct staged keys (primary included) — the gloss detector's key-count signal (#1730).
 */
export function explodeAliasBags(
	src: DatabaseSync,
	out: DatabaseSync,
	attrs: Map<number, PlaceAttrs>,
	stageRow: StageRow
): { nAlias: number; keyCounts: Map<number, number> } {
	let nAlias = 0
	const keyCounts = new Map<number, number>()
	out.exec("BEGIN")

	for (const r of src.prepare("SELECT wof_id, alt_names FROM place_search").iterate()) {
		const a = attrs.get(Number(r.wof_id))
		const alt = r.alt_names as string | null

		if (!a || !alt) continue
		const seen = new Set<string>([a.pkey])

		for (const piece of alt.split(ALIAS_SEP)) {
			const k = normalizeLocalityForKey(piece)

			if (!k || seen.has(k)) continue
			seen.add(k)
			stageRow(k, a, Number(r.wof_id), 0)

			nAlias++
		}

		keyCounts.set(Number(r.wof_id), seen.size)
	}

	out.exec("COMMIT")

	return { nAlias, keyCounts }
}
