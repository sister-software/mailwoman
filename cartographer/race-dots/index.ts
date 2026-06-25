/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Race-by-dot-density overlay — the Cooper Center "Racial Dot Map" reading, on the demo. One dot
 *   per ~N people, placed at random inside its Census block (built by
 *   `scripts/census/race-dots.ts`
 *
 *   - Tippecanoe), colored by 2020 P.L. 94-171 race/ethnicity category.
 *
 *   The PMTiles ships a single `dots` source-layer carrying a `cat` property; we expose each category
 *   as its OWN default-off circle layer (filtered on `cat`) so the demo's LayerToggleControl gives
 *   each its own checkbox — show the full mosaic, or isolate one group's geography, no extra UI.
 *   Same idiom as the coverage overlay.
 *
 *   Served as XYZ vector tiles by the tile worker from `nexus-assets/tiles/race-dots-la.pmtiles`; the
 *   consumer passes its TileJSON URL (`tiles.sister.software/race-dots-la.json`) to
 *   `createRaceDotsSource`.
 *
 *   The dot is a _representation_, not a record: a random position inside the block, standing in for
 *   ~N real people of that category. It says nothing about any individual address.
 */

import type { CircleLayerSpecification, VectorSourceSpecification } from "@maplibre/maplibre-gl-style-spec"
import { TileSetSourceID } from "../styles/sources.js"

export const RaceDotsTileSetID = TileSetSourceID("race-dots-la")

/** The single source-layer the race-dots PMTiles ships (tippecanoe `-l dots`). */
export const RACE_DOTS_SOURCE_LAYER = "dots"

/** The togglable categories. Each becomes its own default-off layer + LayerToggleControl checkbox. */
export const RaceDotsCategories = [
	{ id: "race-dots-white", label: "Race · White", color: "#1f78b4", match: ["white"] },
	{ id: "race-dots-black", label: "Race · Black", color: "#33a02c", match: ["black"] },
	{ id: "race-dots-hispanic", label: "Race · Hispanic", color: "#ff7f00", match: ["hispanic"] },
	{ id: "race-dots-asian", label: "Race · Asian", color: "#e31a1c", match: ["asian"] },
	{ id: "race-dots-other", label: "Race · Other", color: "#8c6d31", match: ["aian", "nhpi", "other", "multi"] },
] as const

/** Build the race-dots source spec from the tile worker's TileJSON endpoint. */
export function createRaceDotsSource(url: string): VectorSourceSpecification {
	return { type: "vector", url }
}

function dotLayer(id: string, color: string, cats: readonly string[]): CircleLayerSpecification {
	return {
		id,
		type: "circle",
		source: RaceDotsTileSetID,
		"source-layer": RACE_DOTS_SOURCE_LAYER,
		// Default OFF — an overlay, surfaced via the layer toggle, never on by default.
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
 * One default-off circle layer per category. Plain MapLibre specs — the demo adds them imperatively
 * on map-load with a `beforeId` of the first symbol layer, so the dots sit beneath place labels.
 */
export const RaceDotsLayers: CircleLayerSpecification[] = RaceDotsCategories.map((c) =>
	dotLayer(c.id, c.color, c.match)
)
