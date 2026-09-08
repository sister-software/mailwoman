/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { RasterSourceSpecification, VectorSourceSpecification } from "@maplibre/maplibre-gl-style-spec"

import { TileSetSourceID } from "#styles/sources"

/**
 * The vector source carrying a body's IAU nomenclature: one `nomenclature` source layer of named features.
 */
export const PlanetaryNomenclatureSourceID = TileSetSourceID("nomenclature")

/**
 * The raster source carrying a body's hillshade, rendered from its DEM at build time.
 */
export const PlanetaryHillshadeSourceID = TileSetSourceID("hillshade")

/**
 * MapLibre resolves a TileJSON `url` itself: tiles, bounds, zoom range and attribution all come from the tile worker's
 * document, so nothing here restates them.
 */
export function nomenclatureSource(tileJSONURL: string): VectorSourceSpecification {
	return {
		type: "vector",
		url: tileJSONURL,
	}
}

export function hillshadeSource(tileJSONURL: string): RasterSourceSpecification {
	return {
		type: "raster",
		url: tileJSONURL,
		tileSize: 256,
	}
}
