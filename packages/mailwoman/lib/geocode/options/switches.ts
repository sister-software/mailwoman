// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The on/off settings of a geocode and their defaults.
 *
 *   The module imports only the resolver's own switch defaults, so the geocode command
 *   reads a flag's default from here without loading the geocode pipeline.
 */

import { RESOLVE_SWITCH_DEFAULTS } from "@mailwoman/core/resolver"

/**
 * The on/off settings of a geocode.
 *
 * Every setting has an explicit default in {@link GEOCODE_SWITCH_DEFAULTS}.
 */
export interface GeocodeSwitches {
	/**
	 * Lets `poi.db` entity upgrades reach the venue tier.
	 */
	poiVenueTier: boolean
	/**
	 * Applies deterministic input normalization before the parse.
	 */
	normalizeInput: boolean
	/**
	 * Prefers the postcode-format country prior over the placer when available.
	 */
	postcodeCountryPrior: boolean
	/**
	 * Enforces admin descendant consistency.
	 */
	adminCoherence: boolean
	/**
	 * Re-probes unresolved values across admin bands.
	 * It needs a trace sink.
	 */
	diagnoseUnreachable: boolean
	/**
	 * Attaches resolved-node ancestors to metadata.
	 */
	includeAncestors: boolean
	/**
	 * Lets the postcode's country override the country scope.
	 */
	postcodeCountryCoherence: boolean
	/**
	 * Narrows the postcode systems by the postcode's shape.
	 */
	postcodeShapeCoherence: boolean
	/**
	 * Passes the postcode as a containment hint to locality lookups.
	 */
	postcodeContainmentCoherence: boolean
	/**
	 * Reranks locality candidates by containment in a parsed region.
	 */
	adminContainmentRerank: boolean
	/**
	 * Resolves a dependent locality inside its resolved parent and lets it answer the coordinate.
	 */
	dependentLocalityContainment: boolean
	/**
	 * Resolves a `locality` span written with its country's county designator as its
	 * region's county when no locality of that name is in the region.
	 */
	countyDesignatorFallback: boolean
	/**
	 * Accepts a `subregion` or `region` value that no current division answers
	 * when the value is the name of a former division linked to the resolved locality.
	 * It needs `GeocodeDeps.formerDivisionLookup`.
	 */
	formerDivisions: boolean
	/**
	 * Lets a soft country scope act inside retrieval, and stands the locale head's
	 * country in as a soft scope when it contradicts the inferred scope.
	 */
	scopeCountryRetrieval: boolean
	/**
	 * Resolves one of two `locality` spans inside the other when the gazetteer contains it there.
	 */
	siblingLocalityContainment: boolean
	/**
	 * Uses the postcode-prefix prior.
	 * It needs `GeocodeDeps.postcodePrefixIndex`.
	 */
	postcodePrefixPrior: boolean
	/**
	 * Leaves the separator pieces after a placetype-pair window unbiased, such as the `,` after a child name.
	 */
	pairPriorWordPieces: boolean
	/**
	 * Keeps a segment child's placetype-pair bias off the same-field postcode,
	 * as in `Sutton Coldfield B72 1PU`.
	 */
	pairPriorChildPostcodeStrip: boolean
	/**
	 * Applies the placetype-pair index only when the parse's country is the index's country:
	 * `GeocodeDeps.parseCountry` when set, else the locale head's confident verdict.
	 */
	pairIndexOwnCountry: boolean
	/**
	 * Parses with the gazetteer FST of the country the locale head confidently reads,
	 * through `GeocodeDeps.fstForCountry`, when that country ships one.
	 */
	fstCountryRouting: boolean
	/**
	 * Orders a bare name's candidates by the outcome head's readings when the request sets no hint.
	 *
	 * It is default-on decoder and resolver behavior, so it stays off until a `pass` release verdict.
	 * It needs a model with an outcome head, and without one every candidate keeps today's order.
	 */
	outcomeHeadOrdering: boolean
}

/**
 * The value of each {@link GeocodeSwitches} setting that a geocode leaves unset.
 *
 * A switch the geocode only forwards to the resolver takes the resolver's default.
 * `includeAncestors` departs from it on purpose, because the admin-coherence verdicts read the ancestors.
 */
export const GEOCODE_SWITCH_DEFAULTS: Readonly<GeocodeSwitches> = {
	poiVenueTier: true,
	normalizeInput: true,
	postcodeCountryPrior: true,
	adminCoherence: RESOLVE_SWITCH_DEFAULTS.adminCoherence,
	diagnoseUnreachable: RESOLVE_SWITCH_DEFAULTS.diagnoseUnreachable,
	includeAncestors: true,
	postcodeCountryCoherence: RESOLVE_SWITCH_DEFAULTS.postcodeCountryCoherence,
	postcodeShapeCoherence: RESOLVE_SWITCH_DEFAULTS.postcodeShapeCoherence,
	postcodeContainmentCoherence: RESOLVE_SWITCH_DEFAULTS.postcodeContainmentCoherence,
	adminContainmentRerank: RESOLVE_SWITCH_DEFAULTS.adminContainmentRerank,
	dependentLocalityContainment: RESOLVE_SWITCH_DEFAULTS.dependentLocalityContainment,
	countyDesignatorFallback: RESOLVE_SWITCH_DEFAULTS.countyDesignatorFallback,
	formerDivisions: RESOLVE_SWITCH_DEFAULTS.formerDivisions,
	scopeCountryRetrieval: RESOLVE_SWITCH_DEFAULTS.scopeCountryRetrieval,
	siblingLocalityContainment: RESOLVE_SWITCH_DEFAULTS.siblingLocalityContainment,
	postcodePrefixPrior: RESOLVE_SWITCH_DEFAULTS.postcodePrefixPrior,
	pairPriorWordPieces: false,
	pairPriorChildPostcodeStrip: false,
	pairIndexOwnCountry: false,
	fstCountryRouting: false,
	outcomeHeadOrdering: false,
}

/**
 * Fills each unset switch from {@link GEOCODE_SWITCH_DEFAULTS}.
 */
export function geocodeSwitches(deps: Partial<GeocodeSwitches>): GeocodeSwitches {
	const switches = { ...GEOCODE_SWITCH_DEFAULTS }

	for (const key of Object.keys(GEOCODE_SWITCH_DEFAULTS) as (keyof GeocodeSwitches)[]) {
		switches[key] = deps[key] ?? GEOCODE_SWITCH_DEFAULTS[key]
	}

	return switches
}
