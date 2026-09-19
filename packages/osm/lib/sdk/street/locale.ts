/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country → street-normalization-locale routing for the OSM rooftop build. The normalizer itself
 *   lives in `@mailwoman/resolver-wof-sqlite/street-normalize` (the one-function discipline — the
 *   reader on the resolver side and the builder here must call the identical function). This module
 *   only maps an ISO-3166 country code to the locale that selects the right per-locale rules, and
 *   re-exports the normalizer so the OSM SDK is a self-contained surface.
 */

import { createStreetLocaleRegistry, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street"

/**
 * ISO-3166 alpha-2 (lowercase) → the street-normalization locale. Deliberately small: only the countries we actually
 * ship an OSM rooftop extract for. Adding a country is a one-line entry plus the matching per-locale branch in
 * `normalizeStreetForKeyLocale` — keep them in lockstep.
 */
const COUNTRY_TO_STREET_LOCALE = new Map<string, StreetLocale>([
	["gb", "en"],
	["nz", "en"],
	// AU's extract is G-NAF-sourced (CC-BY rather than OSM), but lives in this provider's home and keys with
	// the same `en` rules — G-NAF stores street types as full words ("street", "close"), which is
	// exactly the surface the `en` normalizer folds.
	["au", "en"],
	["fr", "fr"],
	["de", "de"],
	["nl", "nl"],
	// CA defaults to English. surface routing selects French rules when appropriate.
	["ca", "en"],
	// These locales provide transliteration and abbreviation rules their base folds do not cover.
	["pl", "pl"],
	["vn", "vn"],
	["id", "id"],
	// Islamabad-sector addressing ("House 4, Street 25, F-7/2") is English-typed. the en rules fold it.
	["pk", "en"],
])

const registry = createStreetLocaleRegistry(
	COUNTRY_TO_STREET_LOCALE,
	"Add it to COUNTRY_TO_STREET_LOCALE and add the matching branch in normalizeStreetForKeyLocale before building its OSM rooftop extract."
)

/**
 * Resolve the street-normalization locale for a country. Throws for an unsupported country rather than silently folding
 * with the wrong rules — a extract built with the wrong normalizer keys every street incorrectly and looks fine until a
 * probe misses. Add the country to {@link COUNTRY_TO_STREET_LOCALE} (and a branch in `normalizeStreetForKeyLocale`)
 * before building its extract.
 */
export function streetLocaleForCountry(countryCode: string): StreetLocale {
	return registry.localeFor(countryCode)
}

/**
 * The countries with a registered OSM rooftop street locale (for CLI validation / help text).
 */
export function supportedOSMCountries(): string[] {
	return registry.supported()
}
