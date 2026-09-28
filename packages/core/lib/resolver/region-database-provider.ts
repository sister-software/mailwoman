/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The bundle of street-tier lookups for one region. The provider opens and caches them.
 */

import type { AddressPointLookup, InterpolationLookup, StreetCentroidLookup } from "#resolver/lookup-types"

/**
 * The street-tier databases available to one geocode resolve.
 *
 * Any of them may be absent, in which case resolution falls back to admin records.
 */
export interface RegionDatabases {
	addressPoints?: AddressPointLookup
	interpolation?: InterpolationLookup
	/**
	 * Street centroids rolled up from a national register's rooftop points,
	 * for queries without a house number.
	 *
	 * Only `BANRegionDatabaseProvider` in `@mailwoman/ban` supplies this tier, for France.
	 * The resolver consults it below the address-point and interpolation tiers and above admin.
	 */
	streetCentroids?: StreetCentroidLookup
}

/**
 * Opens and caches the street-tier databases for a region.
 *
 * The key is a slug such as a US state or an ISO 3166-1 alpha-2 country.
 * `for` is synchronous because the resolution ladder is synchronous.
 *
 * A provider therefore learns what is on disk during `warm` and answers `for` from that record.
 * A provider constructed directly must be warmed before its first `for`.
 *
 * Each implementation exposes a static `create` that constructs and warms.
 * Disposal closes every cached handle.
 */
export interface RegionDatabaseProvider<
	TKey extends string = string,
	TDatabases extends RegionDatabases = RegionDatabases,
> extends Disposable {
	/**
	 * Records which databases exist on disk so `for` can answer without touching the filesystem.
	 *
	 * A repeated call is safe.
	 */
	warm(): Promise<void>

	/**
	 * Returns the cached databases for one region, opening them on the first request.
	 *
	 * A region with no database on disk yields a bundle with no members.
	 */
	for(key: TKey): TDatabases
}
