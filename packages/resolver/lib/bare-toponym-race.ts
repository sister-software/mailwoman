/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The bare-toponym admin race. This is the policy for a query that is one bare name ("Japan",
 *   "Georgia"). The locality placetype filter makes country/region namesakes unreachable at any
 *   rank, so the resolver's lookup runs these side races for the tree's lone locality-tagged span
 *   and promotes an admin namesake under the rules each prober documents. Split from `resolve.ts`
 *   so the walk file holds the walk and this one holds the race policy.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { PlacetypeMap } from "@mailwoman/codex/placetype-map"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { loneValueNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { PLACETYPE_SPECIFICITY } from "@mailwoman/gazetteer/whosonfirst/placetypes/specificity"

/**
 * The tree's single value-containing node when it is locality-tagged, else null.
 *
 * This is the bare-toponym shape whose country-placetype sibling race `#lookupAndPick` runs.
 *
 * A bare name the parser tagged `locality` can refer to a country ("Japan", "China", because
 * single country toponyms are out of the parser's training distribution), and the locality
 * placetype filter makes the country row unreachable regardless of how the ranking would order it.
 * Any second value-containing node makes the input address-shaped and the race stays off.
 *
 * `dependent_locality` maps to the same placetype but is an address-interior tag,
 * so only a literal `locality` qualifies.
 */
export function loneBareLocalityNode(tree: AddressTree, placetypeMap: PlacetypeMap): AddressNode | null {
	if (placetypeMap["locality" as ComponentTag] !== "locality") return null
	const lone = loneValueNode(tree)

	return lone?.tag === "locality" ? lone : null
}

/**
 * The log-population dominance a bare region namesake must hold over the locality winner
 * before the bare-toponym race promotes it.
 *
 * The value is DECISIVE_MARGIN_LOG10 from the ablation-expectation model, restated here
 * because the resolver package cannot import the eval harness.
 * If that measured value moves, move this with it.
 */
export const BARE_REGION_DOMINANCE_LOG10 = 0.5

/**
 * Log10(population + 1), 0 when the backend has no population value.
 *
 * The saturation-free magnitude the bare-region dominance rule compares
 * (prominence caps at the backend's populationBoost and erases exactly the margins this rule needs).
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
 * Alias roles the side races refuse to answer through.
 *
 * A lone bare token that only reaches a place via an abbreviation row ("Tó" folds onto Toledo's "TO")
 * or a translation-gloss row did not identify that place.
 * The role-NULL exonym tier stays open, so 格鲁吉亚 can win the country race through its display-name alias.
 *
 * An artifact without the role column ignores the exclusion and the races behave as before.
 */
const BARE_RACE_EXCLUDED_NAME_ROLES: readonly string[] = ["abbr", "gloss"]

/**
 * The best `country`-placetype row for a bare toponym span, or null.
 *
 * `scopedCountry` is the same hard filter the locality query ran under.
 * An explicit caller scope therefore bounds this race too
 * (a foreign country row cannot outrank inside an explicit scope), while the
 * bare-locality posture's withheld scope leaves it worldwide.
 *
 * This race uses exact matches only.
 * The fuzzy tier recovers typos in address spans.
 *
 * A fuzzy country match is a guess this race must never promote.
 *
 * Abbreviation/gloss alias rows never enter ({@link BARE_RACE_EXCLUDED_NAME_ROLES}).
 */
export async function bareCountryCandidate(
	backend: ResolverBackend,
	text: string,
	scopedCountry: string | undefined
): Promise<ResolvedPlace | null> {
	return probeBareRace(backend, text, "country", ["country"], scopedCountry)
}

/**
 * The top exact row of one placetype band for a bare toponym, or null.
 *
 * Every side race shares these rules: one row, abbreviation and gloss aliases excluded,
 * the locality query's scope, an exact match, and a located coordinate.
 *
 * The placetype check is required.
 * A backend may ignore the filter, as test stubs or a partial implementation could,
 * and hand a race a locality row that would then demote the real pick.
 *
 * A failed probe returns null, so a side race never aborts the primary lookup.
 */
async function probeBareRace(
	backend: ResolverBackend,
	text: string,
	placetype: string,
	accepted: readonly string[],
	scopedCountry: string | undefined
): Promise<ResolvedPlace | null> {
	try {
		const hits = await backend.findPlace({
			text,
			placetype,
			limit: 1,
			excludeNameRoles: BARE_RACE_EXCLUDED_NAME_ROLES,
			...(scopedCountry ? { country: scopedCountry } : {}),
		})

		const top = hits[0]

		return top && accepted.includes(top.placetype) && top.exactMatch !== false && !(top.lat === 0 && top.lon === 0)
			? top
			: null
	} catch {
		return null
	}
}

/**
 * The best `region`-placetype row for a bare toponym span, or null.
 *
 * The sibling of {@link #bareCountryCandidate} for the US-state class
 * (bare "Georgia"/"Texas" the parser tags `locality`).
 *
 * Uses the same interface.
 * The locality query's country filter bounds it.
 *
 * It accepts exact matches only with abbreviation and gloss rows excluded.
 * The placetype check guards partial backends.
 *
 * The `place_abbr`-staged region abbreviations (bare "TX"/"CA") are role-NULL
 * primaries and stay fully reachable.
 *
 * The exclusion removes only abbreviation aliases like Toledo's "TO".
 */
export async function bareRegionCandidate(
	backend: ResolverBackend,
	text: string,
	scopedCountry: string | undefined
): Promise<ResolvedPlace | null> {
	return probeBareRace(backend, text, "region", ["region", "macroregion"], scopedCountry)
}

/**
 * The sub-locality placetypes {@link bareSublocalityCandidate} probes, coarse to fine:
 * every Who's On First placetype finer than `locality` through `microhood`.
 */
export const BARE_SUBLOCALITY_BANDS: readonly string[] = Object.entries(PLACETYPE_SPECIFICITY)
	.filter(
		([, rank]) =>
			rank != null && rank > PLACETYPE_SPECIFICITY["locality"]! && rank <= PLACETYPE_SPECIFICITY["microhood"]!
	)
	.toSorted((a, b) => (a[1] as number) - (b[1] as number))
	.map(([placetype]) => placetype)

/**
 * The best sub-locality row for a bare toponym with no locality row, or null.
 *
 * A whole-input name such as `Buckingham Palace` can be a Who's On First `neighbourhood` row.
 * The locality placetype filter makes that row unreachable.
 *
 * The resolver would otherwise shorten the span and answer a different place.
 *
 * Bands are probed coarse to fine, and the first exact hit with a coordinate wins.
 * The same scope, exact-match and alias-role rules as the country and region races apply.
 */
export async function bareSublocalityCandidate(
	backend: ResolverBackend,
	text: string,
	scopedCountry: string | undefined
): Promise<ResolvedPlace | null> {
	for (const placetype of BARE_SUBLOCALITY_BANDS) {
		const top = await probeBareRace(backend, text, placetype, [placetype], scopedCountry)

		if (top) return top
	}

	return null
}

/**
 * The place a bare toponym with no locality row resolves to, or null.
 *
 * It returns the place with the trace check, pick source and node metadata that record the pick.
 *
 * The larger admin namesake from the country and region races wins first.
 * A sub-locality namesake is probed only when neither race hit.
 */
export async function emptyLocalityPick(
	backend: ResolverBackend,
	text: string,
	scopedCountry: string | undefined,
	bareCountry: ResolvedPlace | null,
	bareRegion: ResolvedPlace | null
): Promise<{
	place: ResolvedPlace
	check: string
	source: "empty_admin" | "bare_sublocality"
	metadata: Record<string, boolean>
} | null> {
	const admin = pickLargerAdmin(bareCountry, bareRegion)

	if (admin) {
		return {
			place: admin,
			check: "empty_admin_pick",
			source: "empty_admin",
			metadata: admin === bareRegion ? { bare_region_repick: true } : { bare_country_repick: true },
		}
	}

	const sublocality = await bareSublocalityCandidate(backend, text, scopedCountry)

	return sublocality
		? {
				place: sublocality,
				check: "bare_sublocality_pick",
				source: "bare_sublocality",
				metadata: { bare_sublocality_pick: true },
			}
		: null
}
