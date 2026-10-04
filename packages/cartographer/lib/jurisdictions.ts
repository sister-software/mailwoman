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
import { interpolateSinebow, interpolateViridis } from "d3-scale-chromatic"

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
 * One legend row: a swatch color and what it stands for.
 */
export interface JurisdictionLegendEntry {
	color: string
	label: string
}

/**
 * The legend for one jurisdiction fill: its title, its rows, and a note for a
 * fill with too many classes to list.
 */
export interface JurisdictionLegend {
	title: string
	entries: JurisdictionLegendEntry[]
	note?: string
}

/**
 * A stepped fill: grey below the first stop, then one viridis color per stop.
 *
 * The paint expression and the legend are both built from the same stops, so the two cannot disagree.
 */
function viridisSteps(
	property: string,
	stops: ReadonlyArray<readonly [number, string]>,
	title: string,
	noReading: string
): { color: ExpressionSpecification; legend: JurisdictionLegend } {
	const colors = stops.map((_, index) => interpolateViridis(index / Math.max(1, stops.length - 1)))
	const steps = stops.flatMap(([stop], index) => [stop, colors[index]!])

	return {
		color: ["step", ["coalesce", ["get", property], 0], NO_READING_COLOR, ...steps] as ExpressionSpecification,
		legend: {
			title,
			entries: [
				{ color: NO_READING_COLOR, label: noReading },
				...stops.map(([, label], index) => ({ color: colors[index]!, label })),
			],
		},
	}
}

const draws = viridisSteps(
	"draws",
	[
		[1, "1–9"],
		[10, "10–99"],
		[100, "100–999"],
		[1000, "1,000–9,999"],
		[10_000, "10,000–99,999"],
		[100_000, "100,000–999,999"],
		[1_000_000, "1,000,000 or more"],
	],
	"Training rows drawn",
	"none drawn"
)

const sources = viridisSteps(
	"eligible_sources",
	[
		[1, "1"],
		[2, "2"],
		[3, "3"],
		[4, "4 or more"],
	],
	"Corpus-eligible sources",
	"none eligible"
)

const shapes = viridisSteps(
	"shape_forms",
	[
		[1, "1–2"],
		[3, "3–4"],
		[5, "5–6"],
		[7, "7–8"],
		[9, "9–10"],
		[11, "11 or more"],
	],
	"Address-shape forms drawn",
	"no rows drawn"
)

/**
 * The number of address-system ids the palette assigns a color.
 *
 * The registry's ids are append-only and number 39 today, so this leaves room for new systems.
 */
const ADDRESS_SYSTEM_PALETTE_SIZE = 64

/**
 * The color of address system `id`: sinebow hues stepped by the golden ratio,
 * so consecutive ids land far apart.
 */
export function addressSystemColor(id: number): string {
	return interpolateSinebow((id * 0.618) % 1)
}

/**
 * Builds the `match` fill over address-system ids.
 *
 * The tuple type requires at least one branch, so id 0's branch is written out
 * and the rest are spread after it.
 */
function addressSystemMatch(): ExpressionSpecification {
	const branches = Array.from({ length: ADDRESS_SYSTEM_PALETTE_SIZE - 1 }, (_, index) => [
		index + 1,
		addressSystemColor(index + 1),
	]).flat()

	return [
		"match",
		["to-number", ["coalesce", ["get", "address_system"], -1]],
		0,
		addressSystemColor(0),
		...branches,
		NO_READING_COLOR,
	]
}

const addressSystemFill = addressSystemMatch()

/**
 * The legend for each jurisdiction fill, keyed by layer ID.
 */
export const JurisdictionLegends: Record<string, JurisdictionLegend> = {
	[JurisdictionLayerID.draws]: draws.legend,
	[JurisdictionLayerID.sources]: sources.legend,
	[JurisdictionLayerID.shapes]: shapes.legend,
	[JurisdictionLayerID.addressSystem]: {
		title: "Address system",
		entries: [{ color: NO_READING_COLOR, label: "no layout recorded" }],
		note: "Each system has its own color. Hover a jurisdiction to read its component order.",
	},
}

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
	jurisdictionFill(JurisdictionLayerID.draws, draws.color),
	jurisdictionFill(JurisdictionLayerID.sources, sources.color),
	jurisdictionFill(JurisdictionLayerID.addressSystem, addressSystemFill),
	jurisdictionFill(JurisdictionLayerID.shapes, shapes.color),
	outline,
]
