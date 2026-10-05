/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The map style. A build with a basemap TileJSON URL draws the cartographer base style over that tileset, and
 *   a build without one draws a stub style with one background layer and zero sources. The stub style names no
 *   glyph host and no sprite, so every request of a page that draws it goes to the page's own server.
 */

import { MailwomanBaseTileSetID, StyleSpecificationComposer } from "@mailwoman/cartographer/base"
import type { StyleSpecification } from "maplibre-gl"

/**
 * The style with zero sources that every build without a basemap URL draws, the browser tests among them.
 */
export const STUB_STYLE: StyleSpecification = {
	version: 8,
	name: "opportunity-app-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dce6ec" } }],
}

/**
 * The style for a basemap TileJSON URL, or the stub style when the build has none.
 */
export function basemapStyle(tileJSONURL: string | null): StyleSpecification {
	if (!tileJSONURL) return STUB_STYLE

	return new StyleSpecificationComposer({
		sources: { [MailwomanBaseTileSetID]: { type: "vector", url: tileJSONURL } },
	}).toJSON()
}
