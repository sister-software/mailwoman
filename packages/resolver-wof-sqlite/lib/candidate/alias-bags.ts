/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 2 of the candidate build — explode `place_search.alt_names` into distinct alias rows.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"

import type { CandidateDatabase } from "#candidate-schema"
import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import { ALIAS_SEPARATOR } from "#fts/index"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * The official name of every current region, keyed `${country id}\0${name key}` → region id, from the source `names`
 * table's `official` bit. Empty when the source carries no `names` table (a fixture, or an extract shape).
 *
 * This is the positive evidence behind the one alias refusal below: a name is refused from a region's bag ONLY when
 * another region of the same country holds it as its official name. Three such pairs exist in the admin artifact —
 * `新竹市` on Hsinchu County (the city's official name), `嘉義市` on Chiayi County, `충청남도` on Sejong — and each let the more
 * populous holder of the variant outrank the place the name officially is, so a `新竹市` region node resolved the county
 * and every district scoped to the city contradicted it.
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
 * Pass 2 — explode each place's `place_search.alt_names` bag into distinct-key alias rows (`is_primary = 0`), and count
 * each place's distinct staged keys (primary included) — the gloss detector's key-count signal (#1730).
 *
 * With `regionPlacetypeID` and `ccID` given, a REGION's alias that is another same-country region's official name is
 * refused and counted rather than staged (see {@link officialNameHoldersByRegion}); without them the pass stages every
 * alias.
 */
export function explodeAliasBags(
	src: DatabaseClient<WOFDatabase>,
	out: DatabaseClient<CandidateDatabase>,
	attrs: Map<number, PlaceAttrs>,
	stageRow: StageRow,
	opts: { regionPlacetypeID?: number; ccID?: (code: string | null) => number } = {}
): { nAlias: number; keyCounts: Map<number, number>; regionOfficialRefused: number } {
	let nAlias = 0
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

		if (!a || !alt) continue
		const seen = new Set<string>([a.pkey])
		const isRegion = a.ptid === opts.regionPlacetypeID

		// The writer space-pads each separator and appends a trailing one, so every piece arrives with
		// surrounding whitespace and the last one is empty. `normalizeLocalityForKey` folds both away,
		// and the empty tail falls out at the `!k` guard below.
		for (const piece of alt.split(ALIAS_SEPARATOR)) {
			const k = normalizeLocalityForKey(piece)

			if (!k || seen.has(k)) continue
			seen.add(k)

			if (isRegion) {
				const holder = official.get(`${a.cid}\0${k}`)

				if (typeof holder === "number" && holder !== id) {
					regionOfficialRefused++

					continue
				}
			}

			stageRow(k, a, id, 0)

			nAlias++
		}

		keyCounts.set(id, seen.size)
	}

	out.exec("COMMIT")

	return { nAlias, keyCounts, regionOfficialRefused }
}
