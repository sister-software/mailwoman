// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The switches a map's layer panel offers, grouped by what a reader looks for on the map.
 *
 *   A style layer reaches its switch in one of two ways.
 *   A layer this package composes for an overlay states its switch in its `metadata`
 *   under {@linkcode LAYER_TOGGLE_METADATA_KEY}.
 *
 *   Every other layer is matched by the last `/` segment of its ID against the patterns
 *   in {@linkcode LAYER_TOGGLE_GROUPS}, which match each known layer exactly once.
 *   The land, sea and background fills match {@linkcode BASE_CANVAS_LAYER}
 *   and get no switch, because hiding them leaves a blank map.
 */

/**
 * One switch of the layer panel.
 */
export interface LayerToggle {
	/**
	 * The switch's key, unique across every group.
	 */
	key: string
	label: string
	/**
	 * The layer-ID leaves the switch owns.
	 * A switch declared in layer metadata has none.
	 */
	match?: RegExp
	/**
	 * The set of switches of which at most one shows at a time, such as the four jurisdiction readings.
	 */
	exclusive?: string
	/**
	 * Whether the group's own switch shows this switch.
	 *
	 * A reading that stays hidden until a reader asks for it sets `false`.
	 *
	 * @defaultValue true
	 */
	groupDefault?: boolean
	/**
	 * The basemap layer IDs this switch draws in place of.
	 *
	 * The panel hides them while the switch shows and shows them again when the switch is hidden.
	 */
	replaces?: readonly string[]
}

/**
 * A group of the layer panel, in the panel's top-to-bottom order.
 */
export interface LayerToggleGroup {
	key: string
	label: string
	toggles: readonly LayerToggle[]
}

/**
 * The key of the group that holds the data overlays, where a switch declared
 * in layer metadata goes by default.
 */
export const DATA_OVERLAY_GROUP = "overlays"

/**
 * The layer metadata key under which a composed overlay layer states its switch,
 * as a {@linkcode LayerToggleDeclaration}.
 */
export const LAYER_TOGGLE_METADATA_KEY = "mailwoman:toggle"

/**
 * A switch stated in a layer's metadata, with the group it belongs to.
 */
export interface LayerToggleDeclaration extends LayerToggle {
	group: string
}

/**
 * The layer-ID leaves of the land, sea and background fills.
 * These layers get no switch.
 */
export const BASE_CANVAS_LAYER = /^(?:background|earth|land-underlay|ocean-fill)$/

/**
 * The panel's groups and the basemap switches in each, in the order the panel lists them:
 * names over the map first, then borders, transport, built form, the ground, and the data overlays.
 */
export const LAYER_TOGGLE_GROUPS: readonly LayerToggleGroup[] = [
	{
		key: "places",
		label: "Places & labels",
		toggles: [
			{ key: "countries", label: "Countries", match: /^places_country$/ },
			{ key: "regions", label: "Regions", match: /^places_region$/ },
			{ key: "cities", label: "Cities & towns", match: /^places_locality$/ },
			{ key: "neighborhoods", label: "Neighborhoods", match: /^places_subplace$/ },
			{ key: "pois", label: "Points of interest", match: /^pois$/ },
			{ key: "house-numbers", label: "House numbers", match: /^address_label$/ },
			{ key: "road-names", label: "Road names & shields", match: /^roads_(?:labels_(?:minor|major)|shields)$/ },
			{
				key: "water-names",
				label: "Water & island names",
				match:
					/^(?:water_label_(?:ocean|lakes)|water_waterway_label|earth_label_islands|undersea-(?:line|point)-labels)$/,
			},
		],
	},
	{
		key: "borders",
		label: "Borders",
		toggles: [
			{ key: "national-borders", label: "National", match: /^boundaries_country$/ },
			{ key: "regional-borders", label: "Regional & municipal", match: /^boundaries(?:_band)?$/ },
		],
	},
	{
		key: "transport",
		label: "Roads & transit",
		toggles: [
			{ key: "roads", label: "Roads", match: /^roads_(?:tunnels|bridges|minor|major|highway|link|other)/ },
			{ key: "railways", label: "Railways", match: /^roads_rail/ },
			{ key: "ferries", label: "Ferries", match: /^ferry$/ },
			{ key: "airports", label: "Airports", match: /^(?:roads_(?:runway|taxiway)|landuse_(?:runway|aerodrome))$/ },
			{ key: "one-way", label: "One-way arrows", match: /^(?:roads_oneway|oneway-arrows)$/ },
			{
				key: "street-detail",
				label: "Street detail",
				match: /^(?:crosswalks|bike-lanes|infrastructure-(?:areas|embankments|hedges|walls|kerbs|street-marks))$/,
			},
			{
				key: "utilities",
				label: "Power lines & pipelines",
				match: /^infrastructure-(?:pipelines|power-lines|towers)$/,
			},
		],
	},
	{
		key: "built",
		label: "Buildings & trees",
		toggles: [
			{
				key: "buildings",
				label: "Buildings",
				match: /^(?:buildings|buildings-extruded|basemap-buildings-outline|compact-buildings|city-models)$/,
			},
			{ key: "trees", label: "Trees", match: /^tree-(?:trunks|crowns)$/ },
		],
	},
	{
		key: "ground",
		label: "Land, water & terrain",
		toggles: [
			{
				key: "land-use",
				label: "Land use & parks",
				match:
					/^(?:landcover|landuse_(?:park|guide_map|urban_green|hospital|industrial|school|beach|zoo|pedestrian|pier)|roads_pier)$/,
			},
			{ key: "inland-water", label: "Rivers & lakes", match: /^(?:water|water_stream|water_river|water-outline)$/ },
			{ key: "ocean-depth", label: "Ocean depth", match: /^ocean-(?:depth|coast-glow)$/ },
			{ key: "relief", label: "Relief shading", match: /^hills$/ },
			{ key: "grid", label: "Latitude & longitude grid", match: /^mw-graticule-line$/ },
		],
	},
	{
		key: DATA_OVERLAY_GROUP,
		label: "Data overlays",
		toggles: [
			{
				key: "coverage-optimistic",
				label: "Coverage · optimistic",
				match: /^coverage-opt-fog$/,
				exclusive: "coverage",
				groupDefault: false,
			},
			{
				key: "coverage-measured",
				label: "Coverage · measured",
				match: /^coverage-honest-fog$/,
				exclusive: "coverage",
				groupDefault: false,
			},
			{
				key: "jurisdiction-draws",
				label: "Jurisdictions · training draws",
				match: /^jurisdictions-draws$/,
				exclusive: "jurisdictions",
				groupDefault: false,
			},
			{
				key: "jurisdiction-sources",
				label: "Jurisdictions · eligible sources",
				match: /^jurisdictions-sources$/,
				exclusive: "jurisdictions",
				groupDefault: false,
			},
			{
				key: "jurisdiction-address-system",
				label: "Jurisdictions · address system",
				match: /^jurisdictions-address-system$/,
				exclusive: "jurisdictions",
				groupDefault: false,
			},
			{
				key: "jurisdiction-shapes",
				label: "Jurisdictions · address shapes",
				match: /^jurisdictions-shapes$/,
				exclusive: "jurisdictions",
				groupDefault: false,
			},
			{
				key: "jurisdiction-borders",
				label: "Jurisdictions · borders",
				match: /^jurisdictions-outline$/,
				groupDefault: false,
			},
		],
	},
]

/**
 * The switch a style layer belongs to.
 *
 * - `"canvas"` for a land, sea or background fill.
 *   A fill has no switch.
 * - `null` for a layer neither its metadata nor a pattern places.
 *   The panel can't list such a layer.
 */
export function resolveLayerToggle(layer: {
	id: string
	metadata?: unknown
}): LayerToggleDeclaration | "canvas" | null {
	const declared = readToggleDeclaration(layer.metadata)

	if (declared) return declared

	const leaf = layer.id.slice(layer.id.lastIndexOf("/") + 1)

	if (BASE_CANVAS_LAYER.test(leaf)) return "canvas"

	for (const group of LAYER_TOGGLE_GROUPS) {
		const toggle = group.toggles.find((candidate) => candidate.match?.test(leaf))

		if (toggle) return { ...toggle, group: group.key }
	}

	return null
}

function readToggleDeclaration(metadata: unknown): LayerToggleDeclaration | null {
	if (typeof metadata !== "object" || metadata === null) return null

	const declared = (metadata as Record<string, unknown>)[LAYER_TOGGLE_METADATA_KEY]

	if (typeof declared !== "object" || declared === null) return null

	const { key, label, group } = declared as Partial<LayerToggleDeclaration>

	return typeof key === "string" && typeof label === "string" && typeof group === "string"
		? (declared as LayerToggleDeclaration)
		: null
}
