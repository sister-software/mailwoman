/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The "fog of war" address-COVERAGE overlay. An H3 hexbin tileset (built by
 *   `scripts/build-coverage-tiles.ts`) shades each area by how much address-point data we hold:
 *   covered → clear (the basemap shows through), empty → opaque gray fog. Answers "where do we need
 *   more data" at a glance, and reveals the "looks covered until you zoom in, then it goes gray" gaps.
 *
 *   Each cell carries TWO baked fog values in [0,1] (0 = covered, 1 = empty), so the same tiles drive
 *   either reading without a rebuild:
 *     • `fog_opt` — optimistic: partial coverage lifted toward clear, so a region "looks covered" when
 *       zoomed out and the gaps only surface on zoom-in.
 *     • `fog`     — honest: true coverage fraction, so the gap is visible even at low zoom.
 *   We expose each as its OWN default-off fill layer (`coverage-opt-fog`, `coverage-honest-fog`) so the
 *   demo's LayerToggleControl gives each its own checkbox — pick the reading you want, no extra UI.
 *
 *   Source URL is supplied by the consumer (`createCoverageSource`): the production tileset on
 *   `tiles.sister.software`, or a local `pmtiles://…` for previewing a single-state bake.
 */

import type {
	FillLayerSpecification,
	VectorSourceSpecification,
} from "@maplibre/maplibre-gl-style-spec"
import { TileSetSourceID } from "../styles/sources.js"

export const CoverageTileSetID = TileSetSourceID("coverage-us-v4")

/**
 * The single source-layer the coverage PMTiles ships (see `build-coverage-tiles.ts` → tippecanoe `-l`).
 */
export const COVERAGE_SOURCE_LAYER = "coverage"

/**
 * Fog tint — a near-black indigo reading as "unknown / unsurveyed". Pushed dark (vs a mid indigo) so it
 * holds contrast over the demo's terrain+hillshade basemap, which is itself dark-green over forest where
 * a lighter fog would simply vanish.
 */
export const COVERAGE_FOG_COLOR = "#663399" // Rebecca Purple

/**
 * Opacity of a fully-empty (`fog = 1`) cell. Covered cells scale down from here toward transparent.
 */
export const COVERAGE_MAX_FOG_OPACITY = 0.9

/**
 * Layer IDs, exported so the demo (toggle wiring, imperative add) and tests can reference them.
 */
export const CoverageLayerID = {
	optimistic: "coverage-opt-fog",
	honest: "coverage-honest-fog",
} as const

/**
 * Build the coverage source spec. `url` is either the production TileJSON endpoint
 * (`https://tiles.sister.software/coverage.json`) or a `pmtiles://…` URL for a local single-state bake.
 */
export function createCoverageSource(url: string): VectorSourceSpecification {
	return { type: "vector", url }
}

function fogFill(id: string, fogProperty: "fog" | "fog_opt"): FillLayerSpecification {
	return {
		id,
		type: "fill",
		source: CoverageTileSetID,
		"source-layer": COVERAGE_SOURCE_LAYER,
		// Default OFF — an overlay, surfaced via the layer toggle, never on by default.
		layout: { visibility: "none" },
		paint: {
			"fill-color": COVERAGE_FOG_COLOR,
			// Opacity tracks the cell's fog value; coalesce guards a missing prop to 0 (fully clear).
			"fill-opacity": ["*", ["coalesce", ["to-number", ["get", fogProperty]], 0], COVERAGE_MAX_FOG_OPACITY],
		},
	}
}

/**
 * The two default-off fog fills (optimistic + honest). Plain MapLibre specs — the demo adds them
 * imperatively on map-load with a `beforeId` of the first symbol layer, so the fog sits beneath place
 * labels but above basemap geometry (roads/water vanish under fog where we have no data).
 */
export const CoverageLayers: FillLayerSpecification[] = [
	fogFill(CoverageLayerID.optimistic, "fog_opt"),
	fogFill(CoverageLayerID.honest, "fog"),
]
