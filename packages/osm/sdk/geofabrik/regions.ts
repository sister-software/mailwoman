/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Geofabrik regions the OpenStreetMap build can acquire, each with the countries its extract holds.
 *
 *   A region is the publisher's identity: its path under https://download.geofabrik.de, without the
 *   `-latest.osm.pbf` suffix. A country extraction policy names regions by this identity and never copies a
 *   URL. One region may hold several countries, such as `europe/dach` (Germany, Austria and Switzerland),
 *   and the build acquires it once and derives each requested country from the same file.
 *
 *   Geofabrik clips every extract along a polygon drawn with a margin past the border, so a region's file
 *   also holds addresses on the far side of each land border. `partial` lists a country of which the region holds a
 *   part only, such as Northern Ireland in `europe/ireland-and-northern-ireland`.
 */

/**
 * One Geofabrik region.
 */
export interface GeofabrikRegion {
	/**
	 * The region's path, such as `europe/germany`.
	 */
	id: string
	/**
	 * The uppercase alpha-2 codes of the countries the region's extract holds.
	 */
	countries: readonly string[]
	/**
	 * Countries of {@link countries} the region holds a part of.
	 */
	partial: readonly string[]
}

/**
 * The base URL of Geofabrik's download server.
 */
export const GEOFABRIK_BASE_URL = "https://download.geofabrik.de/"

const REGIONS: readonly GeofabrikRegion[] = [
	{ id: "australia-oceania/new-zealand", countries: ["NZ"], partial: [] },
	{ id: "asia/indonesia", countries: ["ID"], partial: [] },
	{ id: "asia/pakistan", countries: ["PK"], partial: [] },
	{ id: "asia/vietnam", countries: ["VN"], partial: [] },
	{ id: "europe/britain-and-ireland", countries: ["GB", "IE", "IM"], partial: [] },
	{ id: "europe/dach", countries: ["DE", "AT", "CH"], partial: [] },
	{ id: "europe/france", countries: ["FR"], partial: [] },
	{ id: "europe/germany", countries: ["DE"], partial: [] },
	{ id: "europe/ireland-and-northern-ireland", countries: ["IE", "GB"], partial: ["GB"] },
	{ id: "europe/netherlands", countries: ["NL"], partial: [] },
	{ id: "europe/poland", countries: ["PL"], partial: [] },
	{ id: "europe/united-kingdom", countries: ["GB"], partial: [] },
	{ id: "north-america/canada", countries: ["CA"], partial: [] },
]

const BY_ID = new Map(REGIONS.map((region) => [region.id, region]))

/**
 * The region with this identity, or `null` when the registry does not list it.
 */
export function geofabrikRegion(id: string): GeofabrikRegion | null {
	return BY_ID.get(id.replaceAll(/^\/+|\/+$/g, "")) ?? null
}

/**
 * Every listed region whose extract holds `country`, in the registry's order.
 */
export function geofabrikRegionsHolding(country: string): GeofabrikRegion[] {
	const code = country.toUpperCase()

	return REGIONS.filter((region) => region.countries.includes(code))
}

/**
 * Every listed region.
 */
export function geofabrikRegions(): readonly GeofabrikRegion[] {
	return REGIONS
}

/**
 * The URL of a region's latest extract under `baseURL`.
 */
export function geofabrikExtractURL(region: GeofabrikRegion, baseURL: string = GEOFABRIK_BASE_URL): string {
	return new URL(`${region.id}-latest.osm.pbf`, baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString()
}
