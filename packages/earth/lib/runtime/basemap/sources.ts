// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The tile sets Earth's map style draws: the basemap, an overlay the page asks for,
 * and that overlay's postcodes.
 *
 * Each is decided from the source layers its TileJSON lists, read once before the style is composed.
 */

import type { EarthConfig } from "#config"
import { pageTilesetParam } from "#routes"

/**
 * The status a tile worker answers for a tile set it doesn't serve.
 */
const HTTP_NOT_FOUND = 404

/**
 * The source layer every protomaps basemap holds: land.
 *
 * A requested tile set whose TileJSON lists other layers and not this one is an overlay,
 * such as a gazetteer overlay, and draws over the configured basemap.
 */
const BASEMAP_SOURCE_LAYER = "earth"

/**
 * Source layers only a `mailwoman/basemaps` build holds.
 *
 * When the basemap's TileJSON is unreadable, the style keeps the other basemap layers and drops these.
 */
export const BUILD_ONLY_SOURCE_LAYERS = new Set(["trees", "infrastructure"])

/**
 * A tile set drawn over the basemap, with the source layers its TileJSON lists.
 */
export interface OverlaySource {
	url: string
	layers: ReadonlySet<string>
}

/**
 * The basemap the style draws and the overlays drawn over it, each with the
 * source layers its TileJSON lists.
 */
export interface BasemapSources {
	baseURL: string
	baseLayers: ReadonlySet<string>
	overlay: OverlaySource | null
	/**
	 * The overlay's postcode tile set, `wof-postcodes.v2` beside `wof.v2`, when the tile worker serves one.
	 */
	postcodes: OverlaySource | null
}

function basemapTileJSONURL(config: EarthConfig): URL {
	const name = pageTilesetParam("basemap")

	return name ? new URL(`${name}.json`, config.tileWorkerURL) : config.basemapTileJSONURL
}

/**
 * The TileJSON of the postcode tile set published beside an overlay.
 *
 * `-postcodes` goes before the first dot of the overlay's name.
 */
function postcodeTileJSONURL(overlayURL: string): string {
	const url = new URL(overlayURL)
	const file = url.pathname.slice(url.pathname.lastIndexOf("/") + 1)
	const dot = file.indexOf(".")

	return new URL(`${file.slice(0, dot)}-postcodes${file.slice(dot)}`, url).href
}

/**
 * The source layers a TileJSON lists in `vector_layers`.
 *
 * An unreadable TileJSON answers an empty set and logs the failure.
 * With `absentIsExpected`, a 404 answers the empty set without the log, because the tile set is optional.
 */
async function readVectorLayers(
	tileJSONURL: string,
	options: { absentIsExpected?: boolean } = {}
): Promise<ReadonlySet<string>> {
	try {
		const response = await fetch(tileJSONURL)

		if (response.status === HTTP_NOT_FOUND && options.absentIsExpected) return new Set()

		if (!response.ok) throw new Error(`${tileJSONURL} answered ${response.status}`)

		const tileJSON = (await response.json()) as { vector_layers?: Array<{ id: string }> }

		return new Set((tileJSON.vector_layers ?? []).map((layer) => layer.id))
	} catch (error) {
		console.warn("[mailwoman earth] basemap TileJSON unreadable; drawing without the build-only layers", error)

		return new Set()
	}
}

/**
 * Reads the requested tile set's TileJSON and decides whether it is the basemap or an overlay.
 *
 * An unreadable TileJSON keeps the requested tile set as the basemap.
 * An overlay without a postcode tile set beside it, such as `wof.v1`, draws without postcodes.
 */
export async function readBasemapSources(config: EarthConfig): Promise<BasemapSources> {
	const requested = basemapTileJSONURL(config).href
	const requestedLayers = await readVectorLayers(requested)

	if (!requestedLayers.size || requestedLayers.has(BASEMAP_SOURCE_LAYER)) {
		return { baseURL: requested, baseLayers: requestedLayers, overlay: null, postcodes: null }
	}

	const baseURL = config.basemapTileJSONURL.href
	const postcodesURL = postcodeTileJSONURL(requested)

	const [baseLayers, postcodeLayers] = await Promise.all([
		readVectorLayers(baseURL),
		readVectorLayers(postcodesURL, { absentIsExpected: true }),
	])

	return {
		baseURL,
		baseLayers,
		overlay: { url: requested, layers: requestedLayers },
		postcodes: postcodeLayers.size ? { url: postcodesURL, layers: postcodeLayers } : null,
	}
}
