/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Dot-density race overlay for the demo.
 *
 * One dot represents ~N people in a Census block, colored by 2020 race/ethnicity category.
 *
 * The PMTiles has one `dots` source-layer with a `cat` field. Each category is exposed as a
 * separate default-off circle layer so LayerToggleControl can toggle them individually.
 *
 * Served as XYZ vector tiles from `nexus-assets/tiles/race-dots-la.pmtiles`.
 * Pass the TileJSON URL to `createRaceDotsSource`.
 *
 * Each dot is a randomized placement within its area, standing for a count.
 * Reading one as an address misreads the layer.
 */

import type { CircleLayerSpecification, VectorSourceSpecification } from "@maplibre/maplibre-gl-style-spec"

import { TileSetSourceID } from "#styles/sources"

/**
 * Tile set id for the race dot-density layer.
 */
export const RaceDotsTileSetID = TileSetSourceID("race-dots-la")

/**
 * Source-layer name in the race-dots PMTiles.
 */
export const RACE_DOTS_SOURCE_LAYER = "dots"

/**
 * Toggleable categories.
 *
 * Each category maps to a default-off layer.
 */
export const RaceDotsCategories = [
	{ id: "race-dots-white", label: "Race · White", color: "#1f78b4", match: ["white"] },
	{ id: "race-dots-black", label: "Race · Black", color: "#33a02c", match: ["black"] },
	{ id: "race-dots-hispanic", label: "Race · Hispanic", color: "#ff7f00", match: ["hispanic"] },
	{ id: "race-dots-asian", label: "Race · Asian", color: "#e31a1c", match: ["asian"] },
	{ id: "race-dots-other", label: "Race · Other", color: "#8c6d31", match: ["aian", "nhpi", "other", "multi"] },
] as const

/**
 * Build a vector source spec from a TileJSON URL.
 */
export function createRaceDotsSource(url: string): VectorSourceSpecification {
	return { type: "vector", url }
}

function dotLayer(id: string, color: string, cats: readonly string[]): CircleLayerSpecification {
	return {
		id,
		type: "circle",
		source: RaceDotsTileSetID,
		"source-layer": RACE_DOTS_SOURCE_LAYER,
		// The layer starts hidden.
		// A layer toggle reveals it.
		layout: { visibility: "none" },
		filter: cats.length === 1 ? ["==", ["get", "cat"], cats[0]!] : ["in", ["get", "cat"], ["literal", cats]],
		paint: {
			"circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 0.7, 9, 1.7, 12, 2.8, 16, 4.5],
			"circle-color": color,
			"circle-opacity": 0.85,
		},
	}
}

/**
 * One default-off circle layer per category.
 *
 * Added on map load before symbol layers so dots stay under labels.
 */
export const RaceDotsLayers: CircleLayerSpecification[] = RaceDotsCategories.map((c) =>
	dotLayer(c.id, c.color, c.match)
)
