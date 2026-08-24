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
