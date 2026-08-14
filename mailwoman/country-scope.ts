/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Framework-free country-scope policy shared by parse, geocode, and registry commands.
 */

/**
 * Whether the locale-inferred country scopes the resolver.
 */
export type CountryScope = "auto" | "locale" | "none"

/**
 * ISO-3166 country inferred from a BCP-47 locale's final two-letter region subtag.
 */
export function localeToCountry(locale: string | undefined): string | undefined {
	if (!locale) return undefined

	const parts = locale.split("-")
	const region = parts.length > 1 ? parts.at(-1) : undefined

	return region && /^[A-Za-z]{2}$/u.test(region) ? region.toUpperCase() : undefined
}

/**
 * The resolver country for an invocation. An explicit country outranks locale policy; `none` disables the scope.
 */
export function resolverDefaultCountry(
	options: {
		defaultCountry?: string
		locale?: string
		countryScope?: CountryScope
	},
	_candidateActive = false
): string | undefined {
	if (options.defaultCountry === "none") return undefined

	if (options.defaultCountry) return options.defaultCountry

	return options.countryScope === "none" ? undefined : localeToCountry(options.locale)
}
