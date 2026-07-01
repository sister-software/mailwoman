/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country → street-normalization-locale routing for the OSM rooftop build. The NORMALIZER itself
 *   lives in `@mailwoman/resolver-wof-sqlite/street-normalize` (the one-function discipline — the
 *   reader on the resolver side and the builder here must call the identical function). This module
 *   only maps an ISO-3166 country code to the locale that selects the right per-locale rules, and
 *   re-exports the normalizer so the OSM SDK is a self-contained surface.
 */

import { normalizeStreetForKeyLocale, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"

export { normalizeStreetForKeyLocale, type StreetLocale }

/**
 * ISO-3166 alpha-2 (lowercase) → the street-normalization locale. Deliberately small: only the countries we actually
 * ship an OSM rooftop shard for. Adding a country is a one-line entry PLUS the matching per-locale branch in
 * `normalizeStreetForKeyLocale` — keep them in lockstep.
 */
const COUNTRY_TO_STREET_LOCALE = new Map<string, StreetLocale>([
	["fr", "fr"],
	["de", "de"],
	["nl", "nl"],
])

/**
 * Resolve the street-normalization locale for a country. Throws for an unsupported country rather than silently folding
 * with the wrong rules — a shard built with the wrong normalizer keys every street incorrectly and looks fine until a
 * probe misses. Add the country to {@link COUNTRY_TO_STREET_LOCALE} (and a branch in `normalizeStreetForKeyLocale`)
 * before building its shard.
 */
export function streetLocaleForCountry(countryCode: string): StreetLocale {
	const locale = COUNTRY_TO_STREET_LOCALE.get(countryCode.toLowerCase())

	if (!locale) {
		throw new Error(
			`No street-normalization locale registered for country "${countryCode}". ` +
				`Add it to COUNTRY_TO_STREET_LOCALE and add the matching branch in normalizeStreetForKeyLocale before building its OSM rooftop shard.`
		)
	}

	return locale
}

/** The countries with a registered OSM rooftop street locale (for CLI validation / help text). */
export function supportedOSMCountries(): string[] {
	return [...COUNTRY_TO_STREET_LOCALE.keys()]
}
