/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type {
	BackgroundLayerSpecification,
	CircleLayerSpecification,
	HillshadeLayerSpecification,
	SymbolLayerSpecification,
} from "@maplibre/maplibre-gl-style-spec"

import { PlanetaryHillshadeSourceID, PlanetaryNomenclatureSourceID } from "#planetary/sources"
import { PROTOMAPS_FONT_REGULAR } from "#styles/fonts"
import { LayerID } from "#styles/layers"

export interface PlanetaryPalette {
	/**
	 * The body's own surface tone, under the relief. Named `space` for the layer it feeds, which paints the SPHERE under
	 * globe projection rather than the area around it — the field around the globe is the page behind a transparent
	 * canvas, and the app's stylesheet paints it.
	 */
	space: string
	/**
	 * Where a slope faces the light. With `shadow` and `accent` these are what make one body's relief differ from
	 * another's; the tiles carry encoded elevation and no colour of their own.
	 */
	reliefHighlight: string
	/**
	 * Where a slope faces away. Kept translucent so the surface tone reads through flat ground, which would otherwise
	 * take the shadow colour everywhere the terrain is level.
	 */
	reliefShadow: string
	/**
	 * The steepness wash, translucent for the same reason.
	 */
	reliefAccent: string
	labelColor: string
	labelHalo: string
	selection: string
}

/**
 * One palette per body with a published style. The record's keys are the bodies a style can be composed for, so a body
 * without a row here has no style rather than a wrong one.
 */
export const PALETTES = {
	moon: {
		space: "#8d8f95",
		reliefHighlight: "#eef2f8",
		reliefShadow: "rgba(20, 26, 40, 0.55)",
		reliefAccent: "rgba(90, 100, 120, 0.4)",
		labelColor: "#e8eef7",
		labelHalo: "#05070d",
		selection: "#7fd1ff",
	},
	mars: {
		space: "#9a5334",
		reliefHighlight: "#f4a26b",
		reliefShadow: "rgba(74, 29, 14, 0.55)",
		reliefAccent: "rgba(140, 58, 28, 0.4)",
		labelColor: "#f6e3d1",
		labelHalo: "#1a0c06",
		selection: "#ffb37f",
	},
} as const satisfies Record<string, PlanetaryPalette>

export type PlanetaryStyleBody = keyof typeof PALETTES

const PLANETARY_NAMESPACE = "planetary"

/**
 * The body's surface tone, under the relief. Under globe projection a background layer paints the SPHERE, not the
 * viewport, so this is the ground the hillshade shades and not the field around the globe; the app's stylesheet paints
 * that behind a transparent canvas.
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

/**
 * The relief, shaded at draw time from the body's encoded elevation. The tiles carry height and no colour, so every
 * body-specific decision is here: a greyscale image could not be tinted at all, because MapLibre's raster paint
 * properties are brightness, contrast, saturation and hue-rotate, and the last two do nothing without chroma.
 */
export function hillshadeLayer(palette: PlanetaryPalette): HillshadeLayerSpecification {
	return {
		id: PlanetaryHillshadeLayerID,
		type: "hillshade",
		source: PlanetaryHillshadeSourceID,
		paint: {
			// Under 1: these bodies carry relief far sharper than Earth's relative to their radius, and unexaggerated
			// shading reads as noise at globe zooms.
			"hillshade-exaggeration": 0.6,
			"hillshade-highlight-color": palette.reliefHighlight,
			"hillshade-shadow-color": palette.reliefShadow,
			"hillshade-accent-color": palette.reliefAccent,
		},
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
			"text-font": [PROTOMAPS_FONT_REGULAR],
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
