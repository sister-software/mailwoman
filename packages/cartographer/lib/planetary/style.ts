/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { SourceSpecification, StyleSpecification } from "@maplibre/maplibre-gl-style-spec"

import { StyleSpecificationComposer } from "#base/composition"
import {
	hillshadeLayer,
	labelLayer,
	PALETTES,
	type PlanetaryStyleBody,
	selectionLayer,
	spaceLayer,
} from "#planetary/layers"
import {
	hillshadeSource,
	nomenclatureSource,
	PlanetaryHillshadeSourceID,
	PlanetaryNomenclatureSourceID,
} from "#planetary/sources"

export interface PlanetaryStyleOptions {
	body: PlanetaryStyleBody
	/**
	 * The TileJSON document of the body's nomenclature tileset.
	 */
	nomenclatureTileJSONURL: string
	/**
	 * The TileJSON document of the body's hillshade tileset. Without one the style draws labels over bare space.
	 */
	hillshadeTileJSONURL?: string
}

/**
 * A body's whole style: space, the hillshade when a tileset exists, the nomenclature labels, and the selection ring. No
 * Earth layer, no Earth DEM and no sprite reach the result, so a viewer loads nothing Earth-shaped.
 */
export function createPlanetaryStyle(options: PlanetaryStyleOptions): StyleSpecification {
	const palette = PALETTES[options.body]

	const sources: Record<string, SourceSpecification> = {
		[PlanetaryNomenclatureSourceID]: nomenclatureSource(options.nomenclatureTileJSONURL),
	}

	if (options.hillshadeTileJSONURL) {
		sources[PlanetaryHillshadeSourceID] = hillshadeSource(options.hillshadeTileJSONURL)
	}

	const baseLayers = [
		spaceLayer(palette),
		...(options.hillshadeTileJSONURL ? [hillshadeLayer()] : []),
		labelLayer(palette),
		selectionLayer(palette),
	]

	return new StyleSpecificationComposer({
		sources,
		baseLayers,
		hillshadeSource: null,
		sprite: null,
		sky: { "sky-color": palette.space, "horizon-color": palette.space },
	}).toJSON()
}
