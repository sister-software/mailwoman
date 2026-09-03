/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Mapbox Vector Tile (MVT) decoding for map-tui.
 *
 * Wraps @mapbox/vector-tile + pbf behind a plain-data shape (DecodedLayer / DecodedFeature) so the rest of map-tui
 * never touches the upstream library's lazy-geometry classes.
 */

import { VectorTile } from "@mapbox/vector-tile"
import { PbfReader } from "pbf"

export interface DecodedFeature {
	/**
	 * 1 = point, 2 = line, 3 = polygon (MVT geometry types).
	 */
	type: 1 | 2 | 3

	/**
	 * Rings/lines/points in tile-local integer coords (0..extent).
	 */
	geometry: Array<Array<{ x: number; y: number }>>
	properties: Record<string, unknown>
}

export interface DecodedLayer {
	name: string
	extent: number
	features: DecodedFeature[]
}

export function decodeMVT(data: Uint8Array): DecodedLayer[] {
	const tile = new VectorTile(new PbfReader(data))

	return Object.entries(tile.layers).map(([name, layer]) => {
		const features: DecodedFeature[] = []

		for (let index = 0; index < layer.length; index++) {
			const feature = layer.feature(index)

			features.push({
				type: feature.type as 1 | 2 | 3,
				geometry: feature.loadGeometry(),
				properties: feature.properties as Record<string, unknown>,
			})
		}

		return { name, extent: layer.extent, features }
	})
}
