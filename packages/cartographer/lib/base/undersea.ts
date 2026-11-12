// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Labels for undersea features, drawn from the GEBCO undersea gazetteer's
 *   browser asset that `@mailwoman/undersea` builds.
 *
 *   A trench, ridge or fracture zone is published as a line, so its name
 *   follows the line in spaced capitals.
 *   A seamount, deep or basin is published as a point or polygon, and the asset reduces it to a label point.
 */

import type { GeoJSONSourceSpecification, LayerSpecification } from "@maplibre/maplibre-gl-style-spec"

import { MAP_FONT_ITALIC } from "#styles/fonts"
import { LayerID } from "#styles/layers"
import { TileSetSourceID } from "#styles/sources"

/**
 * Identifier for the undersea label source.
 */
export const UnderseaTileSetID = TileSetSourceID("undersea")

const UnderseaLayerID = LayerID.bind(null, UnderseaTileSetID)

/**
 * The label color: a pale blue.
 *
 * Undersea names sit over deep water, where the depth shading is darkest,
 * so a light color reads where a dark one wouldn't.
 */
const UNDERSEA_LABEL_COLOR = "#dff1fb"

/**
 * Creates the label source from the browser asset's URL.
 *
 * The page that draws these labels credits GEBCO in its own footer, so the source sets no attribution.
 */
export function createUnderseaLabelSource(assetURL: string): GeoJSONSourceSpecification {
	return { type: "geojson", data: assetURL }
}

/**
 * The label layers: names along lines from z3, and names at label points from z5.
 */
export const UnderseaLabelLayers: LayerSpecification[] = [
	{
		id: UnderseaLayerID("undersea-line-labels"),
		type: "symbol",
		source: UnderseaTileSetID,
		minzoom: 3,
		filter: ["==", ["geometry-type"], "LineString"],
		layout: {
			"symbol-placement": "line",
			"symbol-spacing": 400,
			"text-field": ["upcase", ["get", "displayName"]],
			"text-font": [MAP_FONT_ITALIC],
			"text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 8, 14],
			"text-letter-spacing": 0.3,
			"text-max-angle": 30,
			"text-optional": true,
		},
		paint: {
			"text-color": UNDERSEA_LABEL_COLOR,
			"text-opacity": 0.85,
			"text-halo-color": "rgba(22, 90, 160, 0.5)",
			"text-halo-width": 1,
		},
	},
	{
		id: UnderseaLayerID("undersea-point-labels"),
		type: "symbol",
		source: UnderseaTileSetID,
		minzoom: 5,
		filter: ["==", ["geometry-type"], "Point"],
		layout: {
			// A deep or basin shows its depth on a second, smaller line, such as `-10,763 m`.
			"text-field": [
				"case",
				["!=", ["get", "depthM"], null],
				[
					"format",
					["get", "displayName"],
					{},
					"\n",
					{},
					["concat", ["number-format", ["get", "depthM"], { locale: "en-US" }], " m"],
					{ "font-scale": 0.85 },
				],
				["get", "displayName"],
			],
			"text-font": [MAP_FONT_ITALIC],
			"text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 10, 13],
			"text-max-width": 8,
			"text-optional": true,
		},
		paint: {
			"text-color": UNDERSEA_LABEL_COLOR,
			"text-opacity": 0.85,
			"text-halo-color": "rgba(22, 90, 160, 0.5)",
			"text-halo-width": 1,
		},
	},
]
