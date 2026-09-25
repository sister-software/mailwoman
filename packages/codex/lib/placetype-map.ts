/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Maps component tags to resolver placetypes, expands placetype filters into equivalence groups and detects
 *   a widened match.
 */

import type { ComponentTag } from "#component"

/**
 * Maps address-component tags to resolver placetypes.
 *
 * The resolver does not query a tag that is missing from the map, and it keeps
 * that tag's classifier attribution unchanged.
 */
export type PlacetypeMap = Partial<Record<ComponentTag, string>>

/**
 * The map used when a backend does not supply its own.
 *
 * `street` and `house_number` are absent because WOF admin has no rows for them.
 * They resolve through the situs extracts.
 *
 * The Japanese tiers map to WOF as follows: prefecture to `region`, municipality
 * to `locality`, and district (大字 or 町名) to `locality`.
 * Only the CJK character model emits these tags.
 */
export const DEFAULT_PLACETYPE_MAP: PlacetypeMap = {
	country: "country",
	region: "region",
	locality: "locality",
	dependent_locality: "locality",
	subregion: "county",
	prefecture: "region",
	municipality: "locality",
	district: "locality",
	// Postcodes resolve only when the backend has a postcode extract.
	postcode: "postalcode",
}

/**
 * Per-country entries that replace {@link DEFAULT_PLACETYPE_MAP} entries
 * where WOF types a tier differently.
 *
 * In Taiwan, WOF types most 鄉鎮市區 districts, which the parser tags `subregion`,
 * as `locality` or `localadmin`, with a minority typed as `county`.
 */
const COUNTRY_PLACETYPE_OVERRIDES: Readonly<Record<string, PlacetypeMap>> = {
	tw: { subregion: "locality" },
}

/**
 * Returns the placetype map for an ISO alpha-2 country code in any case.
 *
 * A country without overrides gets the {@link DEFAULT_PLACETYPE_MAP} object itself,
 * so callers can compare by identity to see whether the map changed.
 */
export function placetypeMapForCountry(countryCode: string | null | undefined): PlacetypeMap {
	const overrides = countryCode ? COUNTRY_PLACETYPE_OVERRIDES[countryCode.toLowerCase()] : undefined

	return overrides ? { ...DEFAULT_PLACETYPE_MAP, ...overrides } : DEFAULT_PLACETYPE_MAP
}

/**
 * The placetypes a lookup filter accepts for each requested placetype.
 *
 * WOF spreads one addressing tier across several placetypes.
 * The first entry in each group is the requested type, and extract routing uses it.
 *
 * - `locality` also accepts `borough`, such as Brooklyn, and `localadmin`, such as French communes.
 * - `region` also accepts `macroregion`, which WOF uses for Italian regions and the current French régions.
 * - `county` also accepts `macrocounty`.
 *
 * Every lookup backend uses this table, so the Node and browser resolvers stay consistent.
 * A placetype without an entry, such as `borough`, is not expanded.
 */
export const PLACETYPE_FILTER_GROUPS: Readonly<Record<string, readonly string[]>> = {
	locality: ["locality", "borough", "localadmin"],
	region: ["region", "macroregion"],
	county: ["county", "macrocounty"],
}

/**
 * Expands a placetype filter through {@link PLACETYPE_FILTER_GROUPS}.
 *
 * The result has no duplicates and keeps the first entry first, because extract routing uses it.
 * A `null` filter returns `null`.
 */
export function expandPlacetypeFilter(placetypes: null): null
export function expandPlacetypeFilter(placetypes: readonly string[]): string[]
export function expandPlacetypeFilter(placetypes: readonly string[] | null): string[] | null

export function expandPlacetypeFilter(placetypes: readonly string[] | null): string[] | null {
	if (!placetypes) return null
	const out: string[] = []

	for (const placetype of placetypes) {
		for (const expanded of PLACETYPE_FILTER_GROUPS[placetype] ?? [placetype]) {
			if (!out.includes(expanded)) {
				out.push(expanded)
			}
		}
	}

	return out
}

/**
 * Group members that are a broader tier than the requested placetype.
 *
 * The `borough` and `localadmin` members of the `locality` group are peers of
 * `locality`, so they are excluded from this set.
 */
const MACRO_FALLBACK_PLACETYPES: ReadonlySet<string> = new Set(["macroregion", "macrocounty"])

/**
 * Returns whether a candidate matched the requested placetype only through a broader macro tier.
 *
 * For example, `macroregion` is a fallback for `region`.
 * The resolver ranks exact types first and marks a macro-only match with `resolutionQuality: "fallback"`.
 * Every other combination returns false.
 */
export function isPlacetypeFallback(requestedPlacetype: string, candidatePlacetype: string): boolean {
	const group = PLACETYPE_FILTER_GROUPS[requestedPlacetype]

	if (!group) return false

	if (candidatePlacetype === requestedPlacetype) return false

	return MACRO_FALLBACK_PLACETYPES.has(candidatePlacetype) && group.includes(candidatePlacetype)
}
