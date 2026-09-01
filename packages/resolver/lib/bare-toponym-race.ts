/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The bare-toponym ADMIN race — the policy for a query that is one bare name ("Japan", "Georgia").
 *   The locality placetype filter makes country/region namesakes unreachable at any rank, so the
 *   resolver's lookup runs these side races for the tree's lone locality-tagged span and promotes an
 *   admin namesake under the rules each prober documents. Split from `resolve.ts` so the walk file
 *   holds the walk and this one holds the race policy.
 */

import type { AddressNode, AddressTree, ComponentTag } from "@mailwoman/core/decoder"
import { loneValueBearingNode } from "@mailwoman/core/decoder"
import type { PlacetypeMap, ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"

/**
 * The tree's single value-bearing node when it is locality-tagged, else null — the bare-toponym shape whose
 * country-placetype sibling race `#lookupAndPick` runs. A bare name the parser tagged `locality` can name a country
 * ("Japan", "China" — single country names are out of the parser's training distribution), and the locality placetype
 * filter makes the country row unreachable regardless of how the ranking would order it. Any second value-bearing node
 * makes the input address-shaped and the race stays off; `dependent_locality` maps to the same placetype but is an
 * address-interior tag, so only a literal `locality` qualifies.
 */
export function loneBareLocalityNode(tree: AddressTree, placetypeMap: PlacetypeMap): AddressNode | null {
	if (placetypeMap["locality" as ComponentTag] !== "locality") return null
	const lone = loneValueBearingNode(tree)

	return lone?.tag === "locality" ? lone : null
}

/**
 * The log-population dominance a bare REGION namesake must hold over the locality winner before the bare-toponym race
 * promotes it. The value is DECISIVE_MARGIN_LOG10 from the ablation-expectation model (0.5 — below it the top-ranked
 * place is the intended one 52.4% of the time, above it 89.1%); restated here because the resolver package cannot
 * import the eval harness. If that measured value moves, move this with it.
 */
export const BARE_REGION_DOMINANCE_LOG10 = 0.5

/**
 * Log10(population + 1), 0 when the backend carries none — the saturation-free magnitude the bare-region dominance rule
 * compares (prominence caps at the backend's populationBoost and erases exactly the margins this rule needs).
 */
export function logPopulation(place: ResolvedPlace): number {
	return Math.log10((place.population ?? 0) + 1)
}

/**
 * The larger-population admin namesake of the two side races, or null when neither ran or hit.
 */
export function pickLargerAdmin(country: ResolvedPlace | null, region: ResolvedPlace | null): ResolvedPlace | null {
	if (!country) return region

	if (!region) return country

	return logPopulation(region) > logPopulation(country) ? region : country
}

/**
 * Alias roles the side races refuse to answer through (#1730): a lone bare token that only reaches a place via an
 * ABBREVIATION row ("Tó" folds onto Toledo's "TO") or a translation-gloss row did not name that place — while the
 * role-NULL exonym tier stays open, which is what lets 格鲁吉亚 win the country race through its display-name alias. An
 * artifact without the role column ignores the exclusion and the races behave as before.
 */
const BARE_RACE_EXCLUDED_NAME_ROLES: readonly string[] = ["abbr", "gloss"]

/**
 * The best `country`-placetype row for a bare toponym span, or null. `scopedCountry` is the same hard filter the
 * locality query ran under — an EXPLICIT caller scope therefore bounds this race too (a foreign country row cannot
 * outrank inside an explicit scope), while the bare-locality posture's withheld scope leaves it worldwide. Exact
 * matches only: the fuzzy tier exists for typo recovery on address spans, and a fuzzy country is a guess this race must
 * never promote. Abbreviation/gloss alias rows never enter ({@link BARE_RACE_EXCLUDED_NAME_ROLES}).
 */
export async function bareCountryCandidate(
	backend: ResolverBackend,
	text: string,
	scopedCountry: string | undefined
): Promise<ResolvedPlace | null> {
	try {
		const hits = await backend.findPlace({
			text,
			placetype: "country",
			limit: 1,
			excludeNameRoles: BARE_RACE_EXCLUDED_NAME_ROLES,
			...(scopedCountry ? { country: scopedCountry } : {}),
		})

		const top = hits[0]

		// The placetype check is required, not paranoia: a backend that ignores the filter
		// (several test stubs, and any future partial implementation) would otherwise hand this
		// race a LOCALITY row wearing a country costume, and the repick would demote the real pick.
		return top && top.placetype === "country" && top.exactMatch !== false ? top : null
	} catch {
		// A failed side race must never abort the primary lookup — the locality answer stands.
		return null
	}
}

/**
 * The best `region`-placetype row for a bare toponym span, or null — the sibling of {@link #bareCountryCandidate} for
 * the US-state class (bare "Georgia"/"Texas" the parser tags `locality`). Same contract: the locality query's own
 * country filter bounds it, exact matches only with abbreviation/gloss rows excluded, and the placetype check guards
 * partial backends. (The `place_abbr`-staged region abbreviations — bare "TX"/"CA" — are role-NULL primaries and stay
 * fully reachable; the exclusion removes only the names-table abbreviation ALIASES like Toledo's "TO".)
 */
export async function bareRegionCandidate(
	backend: ResolverBackend,
	text: string,
	scopedCountry: string | undefined
): Promise<ResolvedPlace | null> {
	try {
		const hits = await backend.findPlace({
			text,
			placetype: "region",
			limit: 1,
			excludeNameRoles: BARE_RACE_EXCLUDED_NAME_ROLES,
			...(scopedCountry ? { country: scopedCountry } : {}),
		})

		const top = hits[0]

		return top && (top.placetype === "region" || top.placetype === "macroregion") && top.exactMatch !== false
			? top
			: null
	} catch {
		return null
	}
}
