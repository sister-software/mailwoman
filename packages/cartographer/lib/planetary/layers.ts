/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type {
	BackgroundLayerSpecification,
	CircleLayerSpecification,
	RasterLayerSpecification,
	SymbolLayerSpecification,
} from "@maplibre/maplibre-gl-style-spec"

import { PlanetaryHillshadeSourceID, PlanetaryNomenclatureSourceID } from "#planetary/sources"
import { LayerID } from "#styles/layers"

export interface PlanetaryPalette {
	space: string
	labelColor: string
	labelHalo: string
	selection: string
}

/**
 * One palette per body with a published style. The record's keys are the bodies a style can be composed for, so a body
 * without a row here has no style rather than a wrong one.
 */
export const PALETTES = {
	moon: { space: "#05070d", labelColor: "#e8eef7", labelHalo: "#05070d", selection: "#7fd1ff" },
	mars: { space: "#0a0604", labelColor: "#f6e3d1", labelHalo: "#1a0c06", selection: "#ffb37f" },
} as const satisfies Record<string, PlanetaryPalette>

export type PlanetaryStyleBody = keyof typeof PALETTES

const PLANETARY_NAMESPACE = "planetary"

/**
 * The background layer: the body's space color, drawn first.
 */
export const PlanetarySpaceLayerID = LayerID(PLANETARY_NAMESPACE, "space")

/**
 * The hillshade raster layer, present only when the body has a hillshade tileset.
 */
export const PlanetaryHillshadeLayerID = LayerID(PLANETARY_NAMESPACE, "hillshade")

/**
 * The nomenclature label layer, the one an app reads feature properties from on a click.
 */
export const PlanetaryLabelsLayerID = LayerID(PLANETARY_NAMESPACE, "nomenclature-labels")

/**
 * The selection ring layer, the one an app sets a feature `id` filter on.
 */
export const PlanetarySelectionLayerID = LayerID(PLANETARY_NAMESPACE, "selection")

/**
 * The IAU feature-type codes drawn as spaced capitals: a mare, planitia, oceanus or terra spans a region rather than
 * marking a point, and the wide setting reads as an area name the way a printed atlas sets one.
 */
const REGION_FEATURE_TYPE_CODES = ["ME", "PL", "OC", "TA"]

export function spaceLayer(palette: PlanetaryPalette): BackgroundLayerSpecification {
	return {
		id: PlanetarySpaceLayerID,
		type: "background",
		paint: { "background-color": palette.space },
	}
}

export function hillshadeLayer(): RasterLayerSpecification {
	return {
		id: PlanetaryHillshadeLayerID,
		type: "raster",
		source: PlanetaryHillshadeSourceID,
		paint: { "raster-opacity": 0.9, "raster-resampling": "linear" },
	}
}

/**
 * Labels by feature scale: the tile's per-feature `minzoom` already hides a small crater at a low zoom, so the symbol
 * layer only sizes and prioritizes. `featureTypeCode` is the IAU feature-type code carried in the tile properties (AA
 * crater, MO mons, VA vallis, ME mare, PL planitia, SF satellite feature); `diameterKm` is the feature's diameter.
 */
export function labelLayer(palette: PlanetaryPalette): SymbolLayerSpecification {
	return {
		id: PlanetaryLabelsLayerID,
		type: "symbol",
		source: PlanetaryNomenclatureSourceID,
		"source-layer": "nomenclature",
		layout: {
			"text-field": ["get", "name"],
			"text-font": ["Fira Sans Regular"],
			"text-size": ["interpolate", ["linear"], ["coalesce", ["get", "diameterKm"], 0], 0, 11, 100, 14, 1000, 18],
			"text-transform": ["match", ["get", "featureTypeCode"], REGION_FEATURE_TYPE_CODES, "uppercase", "none"],
			"text-letter-spacing": ["match", ["get", "featureTypeCode"], REGION_FEATURE_TYPE_CODES, 0.15, 0.02],
			"symbol-sort-key": ["-", 0, ["coalesce", ["get", "diameterKm"], 0]],
			"text-allow-overlap": false,
		},
		paint: { "text-color": palette.labelColor, "text-halo-color": palette.labelHalo, "text-halo-width": 1.2 },
	}
}

/**
 * The selection ring. Its filter matches no feature until the app sets one by `id`, so the layer ships in the style and
 * the app never inserts a layer at runtime.
 */
export function selectionLayer(palette: PlanetaryPalette): CircleLayerSpecification {
	return {
		id: PlanetarySelectionLayerID,
		type: "circle",
		source: PlanetaryNomenclatureSourceID,
		"source-layer": "nomenclature",
		filter: ["==", ["get", "id"], ""],
		paint: {
			"circle-radius": 14,
			"circle-color": "transparent",
			"circle-stroke-color": palette.selection,
			"circle-stroke-width": 2,
		},
	}
}
