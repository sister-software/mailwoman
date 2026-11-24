// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The style of a gazetteer overlay tile set, `hrt overlay`'s output, drawn over the basemap.
 *
 *   The tile set holds up to three source layers: `boundaries` as polygons, `extents` as the
 *   rectangle a gazetteer stores for each place, and `points` as each place's label point.
 *   The labels use the theme's ink and map font.
 *
 *   The lines and dots use one purple that the basemap's grey administrative lines
 *   don't use, so the overlay stands apart from them.
 */

import type {
	CircleLayerSpecification,
	LayerSpecification,
	LineLayerSpecification,
	SymbolLayerSpecification,
} from "@maplibre/maplibre-gl-style-spec"

import { GuideMapPalette } from "#base/theme"
import { MAP_FONT_REGULAR } from "#styles/fonts"

/**
 * The source layers a gazetteer overlay tile set can hold.
 */
export const GazetteerOverlaySourceLayer = {
	boundaries: "boundaries",
	extents: "extents",
	points: "points",
} as const

/**
 * The color of a place's boundary and extent: distinct from the basemap's grey administrative line.
 */
const OVERLAY_LINE_COLOR = "#7b3fbf"

/**
 * The style layers that draw a gazetteer overlay source, one or two per source layer the tile set lists.
 *
 * A source layer the tile set lacks gets no style layer, so MapLibre logs no missing-layer error.
 */
export function gazetteerOverlayLayers(source: string, sourceLayers: ReadonlySet<string>): LayerSpecification[] {
	const layers: LayerSpecification[] = []

	if (sourceLayers.has(GazetteerOverlaySourceLayer.boundaries)) {
		layers.push({
			id: `${source}-boundaries`,
			type: "line",
			source,
			"source-layer": GazetteerOverlaySourceLayer.boundaries,
			paint: {
				"line-color": OVERLAY_LINE_COLOR,
				"line-opacity": 0.8,
				"line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 12, 1.5],
			},
		} satisfies LineLayerSpecification)
	}

	if (sourceLayers.has(GazetteerOverlaySourceLayer.extents)) {
		layers.push({
			id: `${source}-extents`,
			type: "line",
			source,
			"source-layer": GazetteerOverlaySourceLayer.extents,
			paint: {
				"line-color": OVERLAY_LINE_COLOR,
				"line-opacity": 0.5,
				"line-width": 0.75,
				"line-dasharray": [2, 2],
			},
		} satisfies LineLayerSpecification)
	}

	if (sourceLayers.has(GazetteerOverlaySourceLayer.points)) {
		layers.push(
			{
				id: `${source}-points`,
				type: "circle",
				source,
				"source-layer": GazetteerOverlaySourceLayer.points,
				paint: {
					"circle-color": OVERLAY_LINE_COLOR,
					"circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 12, 4],
					"circle-stroke-color": "#ffffff",
					"circle-stroke-width": 1,
				},
			} satisfies CircleLayerSpecification,
			{
				id: `${source}-labels`,
				type: "symbol",
				source,
				"source-layer": GazetteerOverlaySourceLayer.points,
				layout: {
					"text-field": ["get", "name"],
					"text-font": [MAP_FONT_REGULAR],
					"text-size": 11,
					"text-offset": [0, 0.9],
					"text-anchor": "top",
					"text-optional": true,
				},
				paint: {
					"text-color": GuideMapPalette.ink,
					"text-halo-color": "#ffffff",
					"text-halo-width": 1.2,
				},
			} satisfies SymbolLayerSpecification
		)
	}

	return layers
}
