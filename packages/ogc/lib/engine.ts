// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The engine the OGC routes delegate to.
 *
 *   The routes own validation, the collection and `bbox` filters, `limit` and the response envelope.
 *   The engine answers one query with every match it found, and lists the
 *   collections its opened layers serve.
 */

import type { OGCBBox } from "#bbox"
import type { OGCCollectionID } from "#collections"

/**
 * One gazetteer place a collection serves as an item.
 */
export interface OGCItem {
	/**
	 * The place's WOF id, the number in its place ID `wof:<id>`.
	 */
	wofID: number
	name: string
	placetype: string
	/**
	 * The ISO 3166-1 alpha-2 code the gazetteer records, or null when it records none.
	 */
	countryCode: string | null
	lon: number
	lat: number
	/**
	 * The label `/search` gives the same place: its name, ancestors and country.
	 */
	displayName: string
}

/**
 * One page of a collection's items.
 */
export interface OGCItemPageRequest {
	/**
	 * Keep only places whose point lies inside the box, or every place when null.
	 */
	bbox: OGCBBox | null
	/**
	 * Start after the place with this WOF id, or at the first place when null.
	 */
	after: number | null
	limit: number
}

/**
 * The reader behind a collection's `/items` routes.
 */
export interface OGCItemSource {
	/**
	 * The places the request selects, in ascending WOF id order, at most `limit` of them.
	 */
	page(request: OGCItemPageRequest): Promise<OGCItem[]>
	/**
	 * The place with this WOF id, or null when the collection holds no such place.
	 */
	item(wofID: number): Promise<OGCItem | null>
}

/**
 * The terms one opened layer records in its `layer_manifest`.
 */
export interface OGCLayerTerms {
	/**
	 * The layer's name as its manifest records it, such as `admin-global-priority`.
	 */
	name: string
	/**
	 * The SPDX expression the manifest records, or null when it records none.
	 */
	license: string | null
	/**
	 * The manifest's `attribution`, or null when it records none.
	 */
	attribution: string | null
	/**
	 * The manifest's `source`, such as `whosonfirst+overture-divisions+geonames`,
	 * or null when it records none.
	 */
	source: string | null
}

/**
 * A collection the engine serves, and the regions its layers cover.
 */
export interface OGCServedCollection {
	id: OGCCollectionID
	/**
	 * The regions that have a layer the engine opened for this collection, such as `FR` or `US-TX`.
	 *
	 * Null when the collection isn't divided by region, as for the worldwide gazetteer.
	 */
	regions: readonly string[] | null
	/**
	 * The reader that serves the collection's items, absent for a collection without `/items`.
	 */
	items?: OGCItemSource
	/**
	 * The manifests of the layers behind the collection.
	 * Its license and source links come from them.
	 *
	 * An empty array means no layer backs the collection.
	 * Absent means the engine read no manifest for it, and the description states that.
	 */
	layers?: readonly OGCLayerTerms[]
}

/**
 * One match for a `/search` query.
 */
export interface OGCSearchHit {
	collectionID: OGCCollectionID
	lon: number
	lat: number
	displayName: string
	/**
	 * The engine's ranking score for the match, or null when the engine measured none.
	 */
	score: number | null
	/**
	 * Why `score` is null, absent when it holds a value.
	 */
	scoreUnmeasured?: string
	/**
	 * The gazetteer place ID of a place match, such as `wof:85975673`.
	 *
	 * Absent for an address, a street or a plus code, and for a place the gazetteer gave no ID.
	 */
	placeID?: string
	/**
	 * The gazetteer placetype of a place match, such as `locality` or `postalcode`.
	 *
	 * Absent for an address, a street or a plus code.
	 */
	placetype?: string
}

/**
 * The engine behind the OGC routes.
 */
export interface OGCEngine {
	/**
	 * The collections the engine serves, in the order `/collections` lists them.
	 */
	readonly collections: readonly OGCServedCollection[]
	/**
	 * Every match for `q`, best first.
	 *
	 * An empty array means the engine found no match.
	 */
	search(q: string): Promise<OGCSearchHit[]>
}
