// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   MapLibre styles for the Protomaps planet tileset, such as `/styles/light.json`.
 *
 *   A style holds the tile URL template itself, so a client that cannot read TileJSON,
 *   such as QGIS, gets the tiles and their symbology from one URL.
 */

import { createBasemapStyle, isBasemapLanguage, isBasemapStyleName } from "@mailwoman/cartographer/base/standalone"
import { PROTOMAPS_PLANET_TILESET_NAME } from "@mailwoman/core/asset-names"
import { ResourceError } from "@mailwoman/core/errors"
import { stringifyJSON } from "@mailwoman/core/json"
import type { Context } from "hono"

import { cacheResponse, type TileWorkerHono } from "#caching"
import { CloudflareWorkerPMTiles } from "#protomaps"

/**
 * A style file's path segment: a style name and `.json`.
 */
export const STYLE_FILE = "[a-z\\-]+\\.json"

/**
 * Serves the style the request's `style` segment selects, labeled in the `lang` query parameter's language.
 */
export async function serveBasemapStyle(c: Context<TileWorkerHono>): Promise<Response> {
	const style = (c.req.param("style") ?? "").slice(0, -".json".length)
	const lang = c.req.query("lang") ?? "en"

	if (!isBasemapStyleName(style)) throw ResourceError.from(404, `Unknown style: ${style}`)

	if (!isBasemapLanguage(lang)) throw ResourceError.from(400, "Invalid lang parameter")

	const pm = CloudflareWorkerPMTiles.from({
		bucket: c.env.MAILWOMAN_TILES_BUCKET,
		pathPrefix: c.env.PMTILES_PATH,
		tileSetName: PROTOMAPS_PLANET_TILESET_NAME,
	})

	const tileJSON = await pm.retrieveTileJSON(PROTOMAPS_PLANET_TILESET_NAME)

	const response = new Response(stringifyJSON(createBasemapStyle({ tileJSON, style, lang })), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "public, max-age=86400",
		},
	})

	cacheResponse(c, response)

	return response
}
