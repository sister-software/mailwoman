/**
 * Shared weights-overlay routing metadata for board runners.
 */

/**
 * Countries with package-specific weights overlays and the locale package each country selects.
 */
export const OVERLAY_LOCALE_BY_COUNTRY: Readonly<Record<string, string>> = {
	GB: "en-GB",
	NZ: "en-NZ",
	DE: "de-DE",
	IN: "en-IN",
	ES: "es-ES",
	IT: "it-IT",
}

export interface BoardRouteInput {
	country?: string | null
	locale?: string | null
}

/**
 * Return the ISO region used to route a board row, preferring its explicit locale over its truth country.
 */
export function routeCountry(row: BoardRouteInput): string | undefined {
	const localeRegion = row.locale?.split("-")[1]

	return localeRegion || row.country || undefined
}

/**
 * Return the weights locale for a routed country, or the base en-US locale when no overlay is declared.
 */
export function overlayLocale(country: string | undefined): string {
	return (country && OVERLAY_LOCALE_BY_COUNTRY[country]) || "en-US"
}

/**
 * Whether a row routed to `country` graded WITHOUT its weights overlay, given the overlay locales that failed to load.
 *
 * A country with no declared overlay answers `false`: it grades through the base package by design, which IS its
 * production path, so calling that degraded would withhold a suggestion the run is entitled to make.
 *
 * `baseOnlyLocales` is keyed by LOCALE because the harness memoizes its fallback per locale — a second country routing
 * to the same overlay takes the cached base classifier and never re-enters the failure path, so a set keyed by country
 * would miss it.
 */
export function gradedBaseOnly(country: string | undefined, baseOnlyLocales: ReadonlySet<string>): boolean {
	const locale = country ? OVERLAY_LOCALE_BY_COUNTRY[country] : undefined

	return locale ? baseOnlyLocales.has(locale) : false
}
