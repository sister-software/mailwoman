/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country → street-normalization-locale routing for the BAN rooftop build. The NORMALIZER itself
 *   lives in `@mailwoman/resolver-wof-sqlite/street-normalize` (the one-function discipline — the
 *   reader on the resolver side and the builder here must call the identical function). This module
 *   only maps an ISO-3166 country code to the locale that selects the right per-locale rules, and
 *   re-exports the normalizer so the BAN SDK is a self-contained surface. Kept SEPARATE from the
 *   heavy `shard-provider.ts` (which pulls the SQLite lookup) so the pure locale contract is testable
 *   without opening a database — mirrors `@mailwoman/osm`'s `street-locale.ts`.
 */

import { normalizeStreetForKeyLocale, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"

export { normalizeStreetForKeyLocale, type StreetLocale }

/**
 * ISO-3166 alpha-2 (lowercase) → the street-normalization locale a BAN shard was built with. FR-only: BAN is the French
 * national register. Adding a country here means shipping that country's national register on the shared schema AND
 * having a matching branch in `normalizeStreetForKeyLocale` — never a silent fold with the wrong rules.
 */
const BAN_COUNTRY_TO_STREET_LOCALE = new Map<string, StreetLocale>([["fr", "fr"]])

/**
 * Resolve the street-normalization locale for a BAN country. Throws for an unsupported country rather than silently
 * folding with the wrong rules — a shard built with the wrong normalizer keys every street incorrectly and looks fine
 * until a probe misses. Add the country to {@link BAN_COUNTRY_TO_STREET_LOCALE} (and a branch in
 * `normalizeStreetForKeyLocale`) before building its shard.
 */
export function streetLocaleForBANCountry(countryCode: string): StreetLocale {
	const locale = BAN_COUNTRY_TO_STREET_LOCALE.get(countryCode.toLowerCase())

	if (!locale) {
		throw new Error(
			`No BAN street-normalization locale registered for country "${countryCode}". ` +
				`Add it to BAN_COUNTRY_TO_STREET_LOCALE and add the matching branch in normalizeStreetForKeyLocale before building its shard.`
		)
	}

	return locale
}

/** The countries with a registered BAN street locale (for CLI validation / provider gating). */
export function supportedBANCountries(): string[] {
	return [...BAN_COUNTRY_TO_STREET_LOCALE.keys()]
}
