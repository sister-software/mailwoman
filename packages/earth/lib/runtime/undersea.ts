// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Earth's search over the GEBCO undersea gazetteer.
 *
 *   The admin gazetteer holds administrative places only, so a query such as
 *   `Mariana Trench` finds no undersea feature there.
 *   It can match an admin place instead: the Northern Mariana Islands.
 *
 *   An input that equals a feature's whole display name therefore puts that feature first.
 *   A partial name only adds suggestions.
 */

import type { ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import { type UnderseaAsset, type UnderseaFeatureProperties, UnderseaIndex } from "@mailwoman/undersea"

/**
 * The index load for each asset URL, kept so every search after the first reads the same index.
 */
const loads = new Map<string, Promise<UnderseaIndex>>()

/**
 * Loads the browser asset once per URL and indexes it.
 *
 * A failed load is forgotten, so the next search tries again rather than reading the failure forever.
 */
export function loadUnderseaIndex(assetURL: URL): Promise<UnderseaIndex> {
	const key = assetURL.href
	const held = loads.get(key)

	if (held) return held

	const load = fetch(key)
		.then((response) => {
			if (!response.ok) throw new Error(`undersea asset: ${key} answered ${response.status}`)

			return response.json() as Promise<UnderseaAsset>
		})
		.then((asset) => new UnderseaIndex(asset))

	load.catch(() => loads.delete(key))
	loads.set(key, load)

	return load
}

/**
 * A gazetteer feature as a resolved place.
 *
 * The id is 0.
 * That id marks a place outside the Who's On First gazetteer.
 *
 * The result panel and the map then read no admin polygon for it.
 * The place type is the generic term in lowercase, such as `trench`.
 */
export function underseaPlaceView(feature: UnderseaFeatureProperties): ResolvedPlaceView {
	const [lon, lat] = feature.labelPoint
	const [west, south, east, north] = feature.bbox

	return {
		id: 0,
		name: feature.displayName,
		placetype: feature.genericTerm.toLowerCase(),
		lat,
		lon,
		score: 1,
		bbox: { minLat: south, maxLat: north, minLon: west, maxLon: east },
		tier: null,
		uncertaintyM: null,
	}
}
