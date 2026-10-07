/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Framework-free country-scope policy shared by parse, geocode and registry commands.
 */

import type { DefaultCountry } from "@mailwoman/core/resolver"

/**
 * Whether the locale-inferred country scopes the resolver.
 */
export type CountryScope = "auto" | "locale" | "none"

/**
 * ISO-3166 country inferred from a BCP-47 locale's final two-letter region subtag.
 */
export function localeToCountry(locale: string | null): string | null {
	if (!locale) return null

	const parts = locale.split("-")
	const region = parts.length > 1 ? parts.at(-1) : null

	return region && /^[A-Za-z]{2}$/u.test(region) ? region.toUpperCase() : null
}

/**
 * The resolver country scope for an invocation, tagged with where it came from.
 *
 * An explicit `defaultCountry` outranks locale policy and is a `"caller"` scope;
 * `"none"` disables the scope.
 * A country read off the locale's region subtag is `"inferred"`, so evidence in the address may withhold it.
 */
export function resolverDefaultCountry(options: {
	defaultCountry?: string
	locale?: string
	countryScope?: CountryScope
}): DefaultCountry | null {
	if (options.defaultCountry === "none") return null

	if (options.defaultCountry) return { country: options.defaultCountry, source: "caller" }

	if (options.countryScope === "none") return null

	const inferred = localeToCountry(options.locale ?? null)

	return inferred ? { country: inferred, source: "inferred" } : null
}
