// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The one registry of synthetic place-id ranges, and of the range `mailwoman` mints WOF records from.
 *
 *   An upstream WOF id is below 2e9, and a WOF record minted in a `mailwoman` fork takes an id from
 *   {@link MAILWOMAN_WOF_ID_BASE}. Every other source a gazetteer artifact folds in mints ids from a higher base.
 *   The bases must be pairwise distinct. The candidate table's `candidate_ancestor` and
 *   `candidate_interval` sidecars are keyed only by `spr_id`, a result's `placeID` is `wof:<spr_id>`, and the
 *   backend's `ancestors(id)` answers whichever row wrote last. Two builders that pick the same base give two places
 *   one id — which happened twice while each builder kept its own list of the ranges it believed were taken
 *   (NZ localities and Code-Point Open both at 9.7e12, 3,033 shared ids in the served table. CZ districts and the NI
 *   OSM postcodes both at 9.8e12). A docstring cannot enforce distinctness. this module and its test do.
 *
 *   Add a range here, never at the builder. Each holds at least 5e10 ids against a largest occupancy of 1.75 M
 *   (Code-Point Open), so spacing isn't the constraint. the registry is.
 */

/**
 * The first id of the WOF records minted in the `mailwoman` forks, `989 5xx xxxx`.
 *
 * 9895 is the integer code point of `⚧`, so a record's id identifies it as one of ours.
 * The range holds one million ids, above every upstream WOF id and below every synthetic base.
 */
export const MAILWOMAN_WOF_ID_BASE = 9_895_000_000

/**
 * The first id past the `mailwoman` WOF range.
 */
export const MAILWOMAN_WOF_ID_END = 9_896_000_000

/**
 * Reports whether an id was minted in the `mailwoman` WOF range.
 */
export function isMailwomanWOFID(id: number): boolean {
	return Number.isInteger(id) && id >= MAILWOMAN_WOF_ID_BASE && id < MAILWOMAN_WOF_ID_END
}

/**
 * The next free id in the `mailwoman` WOF range: one past the largest id already
 * minted there, or the range's first id when none is.
 * Ids outside the range are ignored.
 *
 * @throws When the range is exhausted.
 */
export function nextMailwomanWOFID(minted: Iterable<number>): number {
	let largest = MAILWOMAN_WOF_ID_BASE - 1

	for (const id of minted) {
		if (isMailwomanWOFID(id) && id > largest) {
			largest = id
		}
	}

	const next = largest + 1

	if (next >= MAILWOMAN_WOF_ID_END) throw new Error(`the mailwoman WOF id range ends at ${MAILWOMAN_WOF_ID_END - 1}`)

	return next
}

/**
 * Overture-sourced admin rows (`fold-overture`).
 *
 * Above any real WOF id.
 */
export const OVERTURE_ID_BASE = 8_000_000_000_000

/**
 * The GeoNames alias fold (`@mailwoman/resolver-wof-sqlite/geonames`).
 */
export const GEONAMES_ID_BASE = 9_000_000_000_000

/**
 * GeoNames postal rows (`@mailwoman/resolver-wof-sqlite/geonames`).
 */
export const GEONAMES_POSTAL_ID_BASE = 9_500_000_000_000

/**
 * The Dutch PC6 postcode database (`gazetteer build nl-pc6`).
 */
export const NL_PC6_ID_BASE = 9_600_000_000_000

/**
 * The linz-derived New Zealand locality database (`gazetteer build nz-localities`).
 */
export const NZ_LOCALITY_ID_BASE = 9_650_000_000_000

/**
 * Code-Point Open, the GB postcode database (`gazetteer build postcode-codepoint`).
 */
export const CODEPOINT_ID_BASE = 9_700_000_000_000

/**
 * The Northern Ireland OSM postcode database (`gazetteer build postcode-ni-osm`).
 */
export const NI_OSM_ID_BASE = 9_800_000_000_000

/**
 * The Prague municipal districts (`gazetteer build cz-districts`).
 */
export const CZ_DISTRICT_ID_BASE = 9_850_000_000_000

/**
 * Taiwan's 鄉鎮市區 from the civil-affairs register (`gazetteer build tw-districts`).
 */
export const TW_DISTRICT_ID_BASE = 9_900_000_000_000

/**
 * Every synthetic range, ascending.
 *
 * The test over this table is what keeps the bases distinct and spaced.
 * A builder reads its own constant above and never this list.
 */
export const SYNTHETIC_ID_RANGES: ReadonlyArray<{ readonly name: string; readonly base: number }> = [
	{ name: "overture", base: OVERTURE_ID_BASE },
	{ name: "geonames", base: GEONAMES_ID_BASE },
	{ name: "geonames-postal", base: GEONAMES_POSTAL_ID_BASE },
	{ name: "nl-pc6", base: NL_PC6_ID_BASE },
	{ name: "nz-locality", base: NZ_LOCALITY_ID_BASE },
	{ name: "codepoint", base: CODEPOINT_ID_BASE },
	{ name: "ni-osm", base: NI_OSM_ID_BASE },
	{ name: "cz-district", base: CZ_DISTRICT_ID_BASE },
	{ name: "tw-district", base: TW_DISTRICT_ID_BASE },
]

/**
 * The smallest room any range is given before the next base.
 *
 * Code-Point Open, the largest occupant, holds 1.75 M ids.
 */
export const SYNTHETIC_ID_RANGE_MIN_WIDTH = 50_000_000_000
