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

import { createStreetLocaleRegistry, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"

export {
	normalizeStreetForKeyLocale,
	streetLocaleForSurface,
	type StreetLocale,
} from "@mailwoman/resolver-wof-sqlite/street-normalize"

/**
 * ISO-3166 alpha-2 (lowercase) → the street-normalization locale. Deliberately small: only the countries we actually
 * ship an OSM rooftop shard for. Adding a country is a one-line entry PLUS the matching per-locale branch in
 * `normalizeStreetForKeyLocale` — keep them in lockstep.
 */
const COUNTRY_TO_STREET_LOCALE = new Map<string, StreetLocale>([
	["gb", "en"],
	["nz", "en"],
	// AU's shard is G-NAF-sourced (CC-BY, not OSM), but lives in this provider's home and keys with
	// the same `en` rules — G-NAF stores street types as full words ("STREET", "CLOSE"), which is
	// exactly the surface the `en` normalizer folds.
	["au", "en"],
	["fr", "fr"],
	["de", "de"],
	["nl", "nl"],
	// CA keys with the `en` BASE, and `streetLocaleForSurface` routes each French-lead surface to the
	// fr rules per row — at build AND at probe, one shared function (the #861 discipline). A shard
	// built before the router keys its French-lead rows under the en fold, so the router's fr keys
	// only match a shard built with it: rebuild the CA shard when adopting. The measured gap the
	// router closes is abbreviation variance (~3,115 rows: "boul"/"Ste-" cannot fold to the full
	// French word under en); the bulk of French surfaces passed through the en fold unchanged on both
	// sides and were already reachable (889,341 QC-bbox "rue " rows answered their own key).
	["ca", "en"],
	// The 2026-08-19 retrieval-coverage lane (census bucket 1). Each locale's rules carry the letter
	// map its NFKD fold cannot supply: pl folds ł→l (Świętokrzyska strips, Łucka does not), vn folds
	// đ→d, id is ASCII-clean. Type abbreviations expand leading (ul→ulica, jl→jalan); vn deliberately
	// ships none — "Đ." folds to a bare "d" and expanding initials is the wrong trade.
	["pl", "pl"],
	["vn", "vn"],
	["id", "id"],
	// Islamabad-sector addressing ("House 4, Street 25, F-7/2") is English-typed; the en rules fold it.
	["pk", "en"],
])

const registry = createStreetLocaleRegistry(
	COUNTRY_TO_STREET_LOCALE,
	"Add it to COUNTRY_TO_STREET_LOCALE and add the matching branch in normalizeStreetForKeyLocale before building its OSM rooftop shard."
)

/**
 * Resolve the street-normalization locale for a country. Throws for an unsupported country rather than silently folding
 * with the wrong rules — a shard built with the wrong normalizer keys every street incorrectly and looks fine until a
 * probe misses. Add the country to {@link COUNTRY_TO_STREET_LOCALE} (and a branch in `normalizeStreetForKeyLocale`)
 * before building its shard.
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
