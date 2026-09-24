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
	 * TileJSON URL for the body's nomenclature tiles.
	 */
	nomenclatureTileJSONURL: string
	/**
	 * Optional hillshade TileJSON URL.
	 * Without it, the style omits terrain shading.
	 */
	hillshadeTileJSONURL?: string
}

/**
 * Create a style for a planetary body with space, optional hillshade, labels, and selection layers.
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
		...(options.hillshadeTileJSONURL ? [hillshadeLayer(palette)] : []),
		labelLayer(palette),
		selectionLayer(palette),
	]

	const style = new StyleSpecificationComposer({
		sources,
		baseLayers,
		hillshadeSource: null,
		sprite: null,
		sky: { "sky-color": palette.space, "horizon-color": palette.space },
	}).toJSON()

	// MapLibre 6 reads globe projection from the style, not the map options.
	return { ...style, projection: { type: "globe" } }
}
