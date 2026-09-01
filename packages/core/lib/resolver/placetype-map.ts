/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Component-tag → resolver-placetype mapping, the equivalence groups a query expands into, and the test
 *   that tells a widened match from an exact one.
 */

import type { ComponentTag } from "#decoder/types"

/**
 * Mapping from mailwoman's address-component tags to the resolver's placetype taxonomy.
 *
 * PARTIAL on purpose: a tag absent from the map is NOT queried, and the resolver pass leaves its classifier attribution
 * untouched. Omission is therefore a routing decision, not an oversight.
 */
export type PlacetypeMap = Partial<Record<ComponentTag, string>>

/**
 * The map used when a backend does not supply its own.
 *
 * `street` and `house_number` are absent because WOF admin has no rows for them — they resolve through the situs
 * extracts instead, which are keyed by street, not by placetype. Locale-specific tiers (JP-style prefecture
 * subdivisions) are absent for the same reason: a different extract entirely.
 */
export const DEFAULT_PLACETYPE_MAP: PlacetypeMap = {
	country: "country",
	region: "region",
	locality: "locality",
	dependent_locality: "locality",
	subregion: "county",
	// `postcode` (mailwoman tag) maps to WOF's `postalcode` placetype. Resolves only when the
	// backend has the postcode extract available — `WOFSQLitePlaceLookup` auto-routes `postalcode`
	// queries to a `postalcode_us` (or similarly-named) extract, falling back to main if absent.
	postcode: "postalcode",
}

/**
 * Placetype-equivalence groups for lookup FILTERING. WOF splits a single addressing tier across several placetypes, but
 * an address's span can name ANY of them. A backend that filters to the one "obvious" placetype makes the equivalents
 * unreachable, so a fuzzy same-name place in the wrong tier wins instead.
 *
 * Three tiers are affected (the value of each entry is the set the SQL filter should accept; the FIRST entry is the
 * canonical/requested type, which extract routing keys off):
 *
 * - **`locality`** — `locality` (most cities), `borough` (Brooklyn, the Paris arrondissements, the London boroughs), and
 *   `localadmin` (FR communes, US towns/townships in New England). Without the group, Brooklyn-the-borough (pop 2.5M)
 *   was unreachable and the fuzzy "Brooklyn Park, MN" won.
 * - **`region`** — `region` + `macroregion` (#718). WOF does NOT model every country's top-level civil division as
 *   `region`: Italian regions (Lombardia, Veneto, Toscana…) are `macroregion` (their PROVINCES are `region`), and the
 *   post-2016 French régions (Île-de-France) are `macroregion` too. An address's `region` span names exactly those, so
 *   a `region`-only filter resolved them to NOTHING (confirmed against the IT/FR eval rows). US states / DE
 *   Bundesländer / ES provincias are genuine `region`, so the EXACT-type match is preferred in ranking (see the
 *   resolve.ts fallback-quality annotation) — the macro is the recall safety net, not a demotion.
 * - **`county`** — `county` + `macrocounty` (#718). The `subregion` ComponentTag maps to `county` via
 *   {@link DEFAULT_PLACETYPE_MAP}; WOF carries `macrocounty` for FR départements-grouping / DE / GB tiers above the
 *   county. Proactive (no eval row exercises `subregion` today) but symmetric with `region` — biasing to inclusion,
 *   since a missed resolution costs more than a too-broad candidate (which is QA-visible). Same exact-type preference
 *   applies.
 *
 * This table is the single source of truth for that expansion, shared by every lookup backend
 * (`@mailwoman/core/resolver-wof-sqlite`, `@mailwoman/core/resolver-wof-wasm`, and the demo's httpvfs lookup) so the
 * Node and browser resolvers can't drift. Keyed by the REQUESTED placetype. Placetypes without an entry pass through
 * unchanged — an explicit `placetype: "borough"` query stays narrow.
 */
export const PLACETYPE_FILTER_GROUPS: Readonly<Record<string, readonly string[]>> = {
	locality: ["locality", "borough", "localadmin"],
	region: ["region", "macroregion"],
	county: ["county", "macrocounty"],
}

/**
 * Expand a placetype filter through {@link PLACETYPE_FILTER_GROUPS}, deduplicated and order-preserving (the first entry
 * stays first — extract routing keys off it). `null`/`undefined` (no filter) passes through untouched.
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
 * Macro/broader-tier members of {@link PLACETYPE_FILTER_GROUPS} — the recall safety net a query may fall through to
 * when no candidate of the EXACT requested placetype exists (#718). DELIBERATELY scoped to the `macro*` tiers only: the
 * `locality` group's `borough`/`localadmin` are genuine peers (Brooklyn-the-borough is a first-class locality answer,
 * #404-class), NOT fallbacks — so they must NOT be deprioritized or annotated. Only `macroregion`/`macrocounty` are a
 * broader admin tier standing in for a true `region`/`county`.
 */
const MACRO_FALLBACK_PLACETYPES: ReadonlySet<string> = new Set(["macroregion", "macrocounty"])

/**
 * Did `candidatePlacetype` resolve `requestedPlacetype` only via a BROADER admin tier (a macro-type fallback within the
 * {@link PLACETYPE_FILTER_GROUPS} expansion), rather than the exact type (#718)?
 *
 * `region` → `region` is exact (false); `region` → `macroregion` is a fallback (true). Scoped to the `macro*` tiers
 * (see {@link MACRO_FALLBACK_PLACETYPES}) so the `locality` group's borough/localadmin peers stay exact. The resolver
 * uses this to (a) prefer an exact-type candidate in ranking and (b) annotate `resolutionQuality: "fallback"` when only
 * a macro-type matched. A placetype outside the requested group, or any non-macro member, is treated as exact (false).
 */
export function isPlacetypeFallback(requestedPlacetype: string, candidatePlacetype: string): boolean {
	const group = PLACETYPE_FILTER_GROUPS[requestedPlacetype]

	if (!group) return false

	if (candidatePlacetype === requestedPlacetype) return false

	return MACRO_FALLBACK_PLACETYPES.has(candidatePlacetype) && group.includes(candidatePlacetype)
}
