// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The bundle of street-tier lookups for one region. The provider opens and caches them.
 */

import type { AddressPointLookup, InterpolationLookup, StreetCentroidLookup } from "#resolver/lookup-types"

/**
 * The street-tier databases available to one geocode resolve.
 *
 * Any of them may be absent, in which case resolution falls back to admin records.
 */
export interface RegionDatabases {
	addressPoints?: AddressPointLookup | null
	interpolation?: InterpolationLookup | null
	/**
	 * Street centroids rolled up from a national register's rooftop points,
	 * for queries without a house number.
	 *
	 * Only `BANRegionDatabaseProvider` in `@mailwoman/ban` supplies this tier, for France.
	 * The resolver consults it below the address-point and interpolation tiers and above admin.
	 */
	streetCentroids?: StreetCentroidLookup | null
}

/**
 * Opens and caches the street-tier databases for a region.
 *
 * The key is a slug such as a US state or an ISO 3166-1 alpha-2 country.
 * `for` is synchronous because the resolution ladder is synchronous.
 *
 * A provider therefore learns what's on disk during `warm` and answers `for` from that record.
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

	/**
	 * The database files `for(key)` reads, one per tier, and where a user obtains
	 * the sources their manifests record.
	 *
	 * A caller reads each file's `layer_manifest` to state the region's terms and sources.
	 * A region with no database on disk yields an empty array.
	 */
	layerDatabases?(key: TKey): readonly RegionLayerDatabase[]
}

/**
 * Where a user obtains one data source: a page that explains how, or lists its downloads.
 */
export interface SourceLocation {
	/**
	 * The source's name for a reader, such as `Base Adresse Nationale`.
	 */
	title: string
	url: string
}

/**
 * One database file a region provider reads for a region.
 */
export interface RegionLayerDatabase {
	tier: keyof RegionDatabases
	path: string
	/**
	 * Where a user obtains each source the provider's layers record, keyed by the source's
	 * name in a manifest's `source`: the part before any `:` scope, such as `ban` in `ban:fr`.
	 */
	sourceLocations: Readonly<Record<string, SourceLocation>>
}
