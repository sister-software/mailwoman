// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The engine the OGC routes delegate to.
 *
 *   The routes own validation, the collection and `bbox` filters, `limit` and the response envelope.
 *   The engine answers one query with every match it found, and lists the
 *   collections its opened layers serve.
 */

import type { OGCCollectionID } from "#collections"

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
