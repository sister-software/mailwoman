// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The collections the OGC surface can describe, and the engine output each one holds.
 *
 *   A collection groups the answers one kind of serving layer produces.
 *   The geocoder reports which tier placed a coordinate, so the tier decides the collection.
 *
 *   The running engine lists only the collections whose layers it opened,
 *   and `/collections` serves that list.
 */

import type { GeocodeResult } from "@mailwoman/core/geocode"
import type { RegionDatabaseProvider } from "@mailwoman/core/resolver"

import type { OGCServedCollection } from "#engine"

type ResolutionTier = GeocodeResult["resolution_tier"]

/**
 * The table maps each collection's name to its id.
 */
export const OGCCollectionID = {
	Addresses: "addresses",
	Streets: "streets",
	Postcodes: "postcodes",
	Places: "places",
	PlusCodes: "plus-codes",
} as const

export type OGCCollectionID = (typeof OGCCollectionID)[keyof typeof OGCCollectionID]

/**
 * The fixed title and description of one collection.
 */
export interface OGCCollectionEntry {
	title: string
	description: string
}

/**
 * The title and description of every collection.
 */
export const OGC_COLLECTION_CATALOG: Readonly<Record<OGCCollectionID, OGCCollectionEntry>> = {
	[OGCCollectionID.Addresses]: {
		title: "Addresses",
		description:
			"House-grade coordinates: a matched address point, or a point interpolated along a street's address range.",
	},
	[OGCCollectionID.Streets]: {
		title: "Streets",
		description: "Street centroids, answering a street named without a house number.",
	},
	[OGCCollectionID.Postcodes]: {
		title: "Postcodes",
		description: "Postcode places from the gazetteer, located at the postcode's own coordinate.",
	},
	[OGCCollectionID.Places]: {
		title: "Places",
		description: "Gazetteer places: localities, districts, counties, regions and countries.",
	},
	[OGCCollectionID.PlusCodes]: {
		title: "Plus codes",
		description: "Open Location Codes the engine decodes to the center of their area. No data layer backs it.",
	},
}

/**
 * The collection that holds an answer the geocoder placed at `tier`.
 *
 * @returns Null for a tier no collection holds, such as `venue`, whose layer the OGC engine doesn't open.
 */
export function collectionOfTier(tier: ResolutionTier): OGCCollectionID | null {
	switch (tier) {
		case "address_point":
		case "interpolated":
			return OGCCollectionID.Addresses
		case "street":
			return OGCCollectionID.Streets
		case "postcode":
			return OGCCollectionID.Postcodes
		case "admin":
			return OGCCollectionID.Places
		case "plus_code":
			return OGCCollectionID.PlusCodes
		case "venue":
			return null
	}
}

/**
 * The collection that holds a gazetteer place of `placetype`.
 */
export function collectionOfPlacetype(placetype: string): OGCCollectionID {
	return placetype === "postalcode" ? OGCCollectionID.Postcodes : OGCCollectionID.Places
}

/**
 * One region-keyed provider of street-tier layers, and the keys to ask it for.
 */
export interface RegionLayerProbe {
	provider: Pick<RegionDatabaseProvider, "for">
	keys: Iterable<string>
	/**
	 * The region code a key names in a collection description, such as `US-TX` for the key `tx`.
	 */
	regionOf: (key: string) => string
}

/**
 * The collections an engine serves, from the layers its providers opened.
 *
 * The gazetteer is always open, because the engine refuses to start without one,
 * so places, postcodes and plus codes are always served.
 * Addresses and streets are served when some region has an address-point, interpolation
 * or street-centroid layer, and their descriptions name those regions.
 *
 * A collection no region has a layer for is left out of the list.
 *
 * A provider opens a region's layers when asked for the region.
 * A query for that region would open them as well.
 */
export function servedCollections(probes: readonly RegionLayerProbe[]): OGCServedCollection[] {
	const addressRegions = new Set<string>()
	const streetRegions = new Set<string>()

	for (const { provider, keys, regionOf } of probes) {
		for (const key of keys) {
			const databases = provider.for(key)

			if (databases.addressPoints || databases.interpolation) {
				addressRegions.add(regionOf(key))
			}

			if (databases.streetCentroids) {
				streetRegions.add(regionOf(key))
			}
		}
	}

	const served: OGCServedCollection[] = []

	if (addressRegions.size) {
		served.push({ id: OGCCollectionID.Addresses, regions: [...addressRegions].toSorted() })
	}

	if (streetRegions.size) {
		served.push({ id: OGCCollectionID.Streets, regions: [...streetRegions].toSorted() })
	}

	served.push(
		{ id: OGCCollectionID.Postcodes, regions: null },
		{ id: OGCCollectionID.Places, regions: null },
		{ id: OGCCollectionID.PlusCodes, regions: null }
	)

	return served
}
