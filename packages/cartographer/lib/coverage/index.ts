/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Address-coverage overlays rendered from the `mailwoman coverage build` H3 tile set. Each cell
 *   supplies optimistic (`fog_opt`) and observed-coverage (`fog`) values. The demo exposes both as
 *   default-off layers. Tiles are served from `coverage-v5.pmtiles`.
 */

import type { FillLayerSpecification, VectorSourceSpecification } from "@maplibre/maplibre-gl-style-spec"

import { TileSetSourceID } from "#styles/sources"

/**
 * MapLibre source ID for the v5 coverage tiles.
 * Keep it aligned with the archive and layer specs.
 */
export const CoverageTileSetID = TileSetSourceID("coverage-v5")

/**
 * Source-layer name stored in the coverage archive.
 */
export const COVERAGE_SOURCE_LAYER = "coverage"

/**
 * Near-black indigo used to mark unknown or unsurveyed areas.
 */
export const COVERAGE_FOG_COLOR = "#663399" // Rebecca Purple

/**
 * Maximum opacity for an uncovered cell.
 */
export const COVERAGE_MAX_FOG_OPACITY = 0.9

/**
 * IDs for the optimistic and observed-coverage layers.
 */
export const CoverageLayerID = {
	optimistic: "coverage-opt-fog",
	honest: "coverage-honest-fog",
} as const

/**
 * Create a vector source from its TileJSON URL.
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
		// Keep coverage overlays hidden until selected.
		layout: { visibility: "none" },
		paint: {
			"fill-color": COVERAGE_FOG_COLOR,
			// Missing coverage values render as clear.
			"fill-opacity": ["*", ["coalesce", ["to-number", ["get", fogProperty]], 0], COVERAGE_MAX_FOG_OPACITY],
		},
	}
}

/**
 * The two hidden fog layers, added beneath place labels by the demo.
 */
export const CoverageLayers: FillLayerSpecification[] = [
	fogFill(CoverageLayerID.optimistic, "fog_opt"),
	fogFill(CoverageLayerID.honest, "fog"),
]
