/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Jurisdiction coverage overlays rendered from the `mailwoman coverage jurisdictions` tile set: one
 *   Natural Earth map unit per jurisdiction, filled by what the training run drew from it, the
 *   address sources the register holds for it, its address system, or the variety of address shapes
 *   among its drawn rows. Each fill is a default-off layer. Tiles are served from `jurisdictions-v1.pmtiles`.
 */

import type {
	ExpressionSpecification,
	FillLayerSpecification,
	LineLayerSpecification,
	VectorSourceSpecification,
} from "@maplibre/maplibre-gl-style-spec"
import { interpolateViridis, schemeTableau10 } from "d3-scale-chromatic"

import { TileSetSourceID } from "#styles/sources"

/**
 * MapLibre source ID for the v1 jurisdiction tiles.
 */
export const JurisdictionTileSetID = TileSetSourceID("jurisdictions-v1")

/**
 * Source-layer name stored in the jurisdiction archive.
 */
export const JURISDICTION_SOURCE_LAYER = "jurisdictions"

/**
 * The fill for a jurisdiction with no reading for the active measure.
 */
const NO_READING_COLOR = "#9e9e9e"

/**
 * The opacity of every jurisdiction fill, so the basemap's labels and borders stay readable.
 */
const FILL_OPACITY = 0.7

/**
 * IDs for the jurisdiction layers.
 *
 * Each fill shares the `jurisdictions-` prefix with the outline.
 */
export const JurisdictionLayerID = {
	draws: "jurisdictions-draws",
	sources: "jurisdictions-sources",
	addressSystem: "jurisdictions-address-system",
	shapes: "jurisdictions-shapes",
	outline: "jurisdictions-outline",
} as const

/**
 * Create a vector source from its TileJSON URL.
 */
export function createJurisdictionSource(url: string): VectorSourceSpecification {
	return { type: "vector", url }
}

function jurisdictionFill(id: string, color: ExpressionSpecification): FillLayerSpecification {
	return {
		id,
		type: "fill",
		source: JurisdictionTileSetID,
		"source-layer": JURISDICTION_SOURCE_LAYER,
		layout: { visibility: "none" },
		paint: { "fill-color": color, "fill-opacity": FILL_OPACITY },
	}
}

/**
 * A viridis ramp over `stops`, with `NO_READING_COLOR` below the first stop.
 */
function viridisSteps(input: ExpressionSpecification, stops: readonly number[]): ExpressionSpecification {
	const steps = stops.flatMap((stop, index) => [stop, interpolateViridis(index / Math.max(1, stops.length - 1))])

	return ["step", input, NO_READING_COLOR, ...steps] as ExpressionSpecification
}

/**
 * Training draws on a log scale: 1, 10, 100 rows and upward to a million.
 * A jurisdiction the run never drew from is grey.
 */
const drawsColor = viridisSteps(["coalesce", ["get", "draws"], 0], [1, 10, 100, 1000, 10_000, 100_000, 1_000_000])

/**
 * Sources that may enter a corpus: grey for none, then one, two, three, and four or more.
 */
const sourcesColor = viridisSteps(["coalesce", ["get", "eligible_sources"], 0], [1, 2, 3, 4])

/**
 * Distinct address-shape forms among the drawn rows, one through twelve.
 */
const shapesColor = viridisSteps(["coalesce", ["get", "shape_forms"], 0], [1, 3, 5, 7, 9, 11])

/**
 * One color per address system, cycling through Tableau 10, so neighbors on
 * different systems read as different.
 * A jurisdiction with no recorded system is grey.
 */
const addressSystemColor: ExpressionSpecification = [
	"case",
	["has", "address_system"],
	["at", ["%", ["to-number", ["get", "address_system"]], schemeTableau10.length], ["literal", [...schemeTableau10]]],
	NO_READING_COLOR,
]

const outline: LineLayerSpecification = {
	id: JurisdictionLayerID.outline,
	type: "line",
	source: JurisdictionTileSetID,
	"source-layer": JURISDICTION_SOURCE_LAYER,
	layout: { visibility: "none" },
	paint: { "line-color": "#424242", "line-width": 0.5 },
}

/**
 * The hidden jurisdiction layers, each a fill by one measure plus a shared outline.
 */
export const JurisdictionLayers: Array<FillLayerSpecification | LineLayerSpecification> = [
	jurisdictionFill(JurisdictionLayerID.draws, drawsColor),
	jurisdictionFill(JurisdictionLayerID.sources, sourcesColor),
	jurisdictionFill(JurisdictionLayerID.addressSystem, addressSystemColor),
	jurisdictionFill(JurisdictionLayerID.shapes, shapesColor),
	outline,
]
