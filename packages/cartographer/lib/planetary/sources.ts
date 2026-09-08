/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { RasterDEMSourceSpecification, VectorSourceSpecification } from "@maplibre/maplibre-gl-style-spec"

import { TileSetSourceID } from "#styles/sources"

/**
 * The vector source carrying a body's IAU nomenclature: one `nomenclature` source layer of named features.
 */
export const PlanetaryNomenclatureSourceID = TileSetSourceID("nomenclature")

/**
 * The elevation source a body's relief is shaded from. The archive carries terrarium-encoded height rather than a
 * shaded picture, so the shading happens at draw time and each body can be tinted from the style.
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

export function hillshadeSource(tileJSONURL: string): RasterDEMSourceSpecification {
	return {
		type: "raster-dem",
		// The build writes `height = (R * 256 + G + B / 256) - 32768`, which is terrarium's, not Mapbox's.
		encoding: "terrarium",
		url: tileJSONURL,
		tileSize: 256,
	}
}
