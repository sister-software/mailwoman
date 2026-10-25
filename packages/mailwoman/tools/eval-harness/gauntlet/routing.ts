/**
 * Shared weights-overlay routing metadata for board runners.
 */

import { readReleaseConfig, weightsPackageByCountry } from "@mailwoman/core/release-config"

/**
 * The weights locale a row grades under when its country ships no overlay: the CLI's default.
 */
const BASE_LOCALE = "en-US"

/**
 * Maps a routed country to the weights overlay the release ships for it, in BCP 47 casing.
 *
 * The map is derived from the `locales` list in `release.config.json`,
 * the packages that share the base model graph.
 * A newly shipped overlay therefore grades under its own weights without a second edit (#2770).
 *
 * The base locale's own country is left out, because the base package is the
 * fallback rather than an overlay.
 * The character-path families under `charWeights` are separate graphs and are not board routes.
 * The held-out grader applies the same rule.
 */
export const OVERLAY_LOCALE_BY_COUNTRY: Readonly<Record<string, string>> = overlayRoutes(
	(await readReleaseConfig()).locales
)

/**
 * Returns the overlay routes for the shipped Latin-graph locales, keyed by country.
 */
function overlayRoutes(locales: readonly string[]): Readonly<Record<string, string>> {
	const baseRegion = routeCountry({ locale: BASE_LOCALE })

	const routes = [...weightsPackageByCountry({ locales: [...locales] })]
		.filter(([country]) => country !== baseRegion)
		.map(([country, locale]) => [country, Intl.getCanonicalLocales(locale)[0] ?? locale])

	return Object.freeze(Object.fromEntries(routes))
}

export interface BoardRouteInput {
	country?: string | null
	locale?: string | null
}

/**
 * Return the ISO region used to route a board row, preferring its explicit locale over its truth country.
 */
export function routeCountry(row: BoardRouteInput): string | null {
	const localeRegion = row.locale?.split("-")[1]

	return localeRegion || row.country || null
}

/**
 * Return the weights locale for a routed country, or the base en-US locale when no overlay is declared.
 */
export function overlayLocale(country: string | null): string {
	return (country && OVERLAY_LOCALE_BY_COUNTRY[country]) || BASE_LOCALE
}

/**
 * Whether a row routed to `country` graded without its weights overlay,
 * given the overlay locales that failed to load.
 *
 * A country with no declared overlay answers `false`: it grades through the base package by design.
 * That is its production path.
 *
 * Therefore, calling that degraded would withhold a suggestion the run is entitled to make.
 *
 * `baseOnlyLocales` is keyed by locale because the harness memoizes its fallback per locale.
 * A second country routing to the same overlay takes the cached base classifier
 * and never re-enters the failure path, so a set keyed by country would miss it.
 */
export function gradedBaseOnly(country: string | null, baseOnlyLocales: ReadonlySet<string>): boolean {
	const locale = country ? OVERLAY_LOCALE_BY_COUNTRY[country] : null

	return locale ? baseOnlyLocales.has(locale) : false
}
