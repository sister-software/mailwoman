// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The style of a gazetteer overlay tile set, `hrt overlay`'s output, drawn over the basemap.
 *
 *   The tile set holds up to three source layers: `boundaries` as polygons, `extents` as the
 *   rectangle a gazetteer stores for each place, and `points` as each place's label point.
 *   A postcode tile set holds `postcode_boundaries` and `postcode_points`.
 *
 *   Each group of placetypes in {@linkcode GAZETTEER_PLACETYPE_TOGGLES} gets its
 *   own style layers and its own switch in the layer panel.
 *   A group paired with a basemap place layer copies that layer's text size, font, case and color.
 *
 *   It reads the same `population_rank` and `min_zoom`.
 *   A Who's On First locality label is therefore sized as the basemap sizes its own city label.
 *
 *   While the group shows, the paired basemap layer is hidden, so a place's name is drawn once.
 *
 *   The lines and dots use one purple that the basemap's grey administrative lines
 *   don't use, so the overlay stands apart from them.
 */

import type {
	CircleLayerSpecification,
	ExpressionSpecification,
	LayerSpecification,
	LineLayerSpecification,
	SymbolLayerSpecification,
} from "@maplibre/maplibre-gl-style-spec"

import { GuideMapPalette } from "#base/theme"
import {
	DATA_OVERLAY_GROUP,
	LAYER_TOGGLE_METADATA_KEY,
	type LayerToggleDeclaration,
	resolveLayerToggle,
} from "#layer-toggles"
import { MAP_FONT_REGULAR } from "#styles/fonts"

/**
 * The source layers a gazetteer overlay tile set can hold.
 */
const GazetteerOverlaySourceLayer = {
	boundaries: "boundaries",
	extents: "extents",
	points: "points",
	postcodeBoundaries: "postcode_boundaries",
	postcodePoints: "postcode_points",
} as const

/**
 * The color of a place's boundary, extent and dot.
 */
const OVERLAY_LINE_COLOR = "#7b3fbf"

/**
 * One switch of the overlay: the placetypes it draws and the basemap layer its labels copy.
 */
interface GazetteerPlacetypeToggle {
	key: string
	label: string
	/**
	 * The placetypes the switch draws.
	 * An empty list draws every placetype no other switch lists.
	 */
	placetypes: readonly string[]
	/**
	 * The basemap place layer whose label style the switch copies and draws in place of.
	 *
	 * Without one, the switch labels its places in the overlay's own small style.
	 */
	basemapLabel?: string
	/**
	 * Whether the switch shows when the page opens.
	 */
	visible: boolean
	/**
	 * Whether the switch labels its points.
	 * A switch without labels draws a dot for each point.
	 */
	labels: boolean
	/**
	 * The boundary line's width at zoom 12, in pixels.
	 */
	lineWidth: number
}

/**
 * The overlay's switches, from the largest places to the smallest.
 *
 * The four basemap pairings follow the basemap's own place kinds: `places_subplace`
 * draws the `macrohood` and `neighbourhood` kinds, and the basemap has no county,
 * borough or microhood label, so those copy the nearest one.
 * Local admin areas start hidden because they repeat most localities: at Paris, zoom 12,
 * the tile held 112 local admin points beside 121 locality points.
 */
const GAZETTEER_PLACETYPE_TOGGLES: readonly GazetteerPlacetypeToggle[] = [
	{
		key: "countries",
		label: "Countries & dependencies",
		placetypes: ["country", "dependency", "disputed"],
		basemapLabel: "places_country",
		visible: true,
		labels: true,
		lineWidth: 1.8,
	},
	{
		key: "regions",
		label: "Regions",
		placetypes: ["macroregion", "region"],
		basemapLabel: "places_region",
		visible: true,
		labels: true,
		lineWidth: 1.4,
	},
	{
		key: "counties",
		label: "Counties",
		placetypes: ["macrocounty", "county"],
		basemapLabel: "places_subplace",
		visible: true,
		labels: true,
		lineWidth: 1.1,
	},
	{
		key: "localities",
		label: "Localities",
		placetypes: ["locality"],
		basemapLabel: "places_locality",
		visible: true,
		labels: true,
		lineWidth: 1,
	},
	{
		key: "local-admin",
		label: "Local admin areas",
		placetypes: ["localadmin"],
		basemapLabel: "places_locality",
		visible: false,
		labels: true,
		lineWidth: 0.8,
	},
	{
		key: "boroughs",
		label: "Boroughs",
		placetypes: ["borough"],
		basemapLabel: "places_subplace",
		visible: true,
		labels: true,
		lineWidth: 0.9,
	},
	{
		key: "neighborhoods",
		label: "Neighborhoods",
		placetypes: ["macrohood", "neighbourhood", "microhood"],
		basemapLabel: "places_subplace",
		visible: true,
		labels: true,
		lineWidth: 0.7,
	},
	{ key: "campuses", label: "Campuses", placetypes: ["campus"], visible: false, labels: true, lineWidth: 0.7 },
	{
		key: "other",
		label: "Continents, oceans & time zones",
		placetypes: [],
		visible: false,
		labels: false,
		lineWidth: 0.7,
	},
]

/**
 * The basemap place layers the overlay's labels replace.
 */
const REPLACED_BASEMAP_LABELS = new Set(["places_country", "places_region", "places_locality", "places_subplace"])

/**
 * The overlay's label switches from the bottom of the layer stack to the top.
 *
 * MapLibre places a higher layer's labels first, and a later label that collides
 * with a placed one is dropped.
 * The basemap stacks `places_subplace`, `places_region`, `places_locality` and `places_country` from
 * bottom to top, so a country or city name claims its place before the neighborhood names around it.
 *
 * The overlay follows that order and puts each unpaired switch beside its nearest pair.
 */
const LABEL_STACK = [
	"other",
	"campuses",
	"neighborhoods",
	"boroughs",
	"counties",
	"regions",
	"local-admin",
	"localities",
	"countries",
]

function labelStackIndex(layerID: string, source: string): number {
	const key = layerID.slice(`${source}-`.length).replace(/-(?:labels|points)$/, "")

	return LABEL_STACK.indexOf(key)
}

const ALL_LISTED_PLACETYPES = GAZETTEER_PLACETYPE_TOGGLES.flatMap((toggle) => toggle.placetypes)

function placetypeFilter(toggle: GazetteerPlacetypeToggle): ExpressionSpecification {
	return toggle.placetypes.length
		? ["in", ["get", "placetype"], ["literal", [...toggle.placetypes]]]
		: ["!", ["in", ["get", "placetype"], ["literal", ALL_LISTED_PLACETYPES]]]
}

function toggleMetadata(
	source: string,
	toggle: Pick<GazetteerPlacetypeToggle, "key" | "label" | "visible" | "basemapLabel">
): Record<string, LayerToggleDeclaration> {
	const replaces =
		toggle.basemapLabel && REPLACED_BASEMAP_LABELS.has(toggle.basemapLabel) ? [toggle.basemapLabel] : undefined

	return {
		[LAYER_TOGGLE_METADATA_KEY]: {
			key: `${source}/${toggle.key}`,
			label: `Who's On First · ${toggle.label}`,
			group: DATA_OVERLAY_GROUP,
			groupDefault: toggle.visible,
			...(replaces ? { replaces } : {}),
		},
	}
}

function visibility(visible: boolean): "visible" | "none" {
	return visible ? "visible" : "none"
}

/**
 * The value a copied basemap expression reads for a field an overlay feature lacks.
 *
 * Each value is the one the basemap's own tiles give a place with no recorded
 * population: rank 1, first drawn at zoom 0.
 *
 * A tile set built before the overlay recorded these fields, such as `wof.v1`,
 * then draws every place at the small size rather than failing the expression.
 */
const BASEMAP_FIELD_FALLBACKS: Readonly<Record<string, number>> = { population_rank: 1, min_zoom: 0 }

/**
 * The expression with each read of a field in {@linkcode BASEMAP_FIELD_FALLBACKS} given its fallback.
 */
function withFieldFallbacks<T>(value: T): T {
	if (!Array.isArray(value)) {
		if (typeof value !== "object" || value === null) return value

		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withFieldFallbacks(entry)])) as T
	}

	const [operator, field] = value

	if (operator === "get" && value.length === 2 && typeof field === "string" && field in BASEMAP_FIELD_FALLBACKS) {
		return ["coalesce", value, BASEMAP_FIELD_FALLBACKS[field]] as T
	}

	return value.map(withFieldFallbacks) as T
}

/**
 * A label layer that copies a basemap place layer's layout and paint, over the overlay's points.
 *
 * The copy reads the overlay's `name`, because the basemap's names come from localized
 * fields the overlay lacks, and sorts larger places first by `population_rank`.
 */
function copiedLabelLayer(
	base: SymbolLayerSpecification,
	source: string,
	toggle: GazetteerPlacetypeToggle
): SymbolLayerSpecification {
	return {
		id: `${source}-${toggle.key}-labels`,
		type: "symbol",
		source,
		"source-layer": GazetteerOverlaySourceLayer.points,
		filter: placetypeFilter(toggle),
		metadata: toggleMetadata(source, toggle),
		layout: {
			...withFieldFallbacks(base.layout),
			"text-field": ["get", "name"],
			"symbol-sort-key": ["-", ["coalesce", ["get", "population_rank"], 0]],
			visibility: visibility(toggle.visible),
		},
		...(base.paint ? { paint: withFieldFallbacks(base.paint) } : {}),
	}
}

/**
 * The overlay's own small label, for a switch with no basemap pairing.
 */
function ownLabelLayer(source: string, toggle: GazetteerPlacetypeToggle): SymbolLayerSpecification {
	return {
		id: `${source}-${toggle.key}-labels`,
		type: "symbol",
		source,
		"source-layer": GazetteerOverlaySourceLayer.points,
		filter: placetypeFilter(toggle),
		metadata: toggleMetadata(source, toggle),
		layout: {
			"text-field": ["get", "name"],
			"text-font": [MAP_FONT_REGULAR],
			"text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 16, 12],
			"text-optional": true,
			visibility: visibility(toggle.visible),
		},
		paint: {
			"text-color": GuideMapPalette.ink,
			"text-halo-color": "#ffffff",
			"text-halo-width": 1.2,
		},
	}
}

/**
 * The style layers that draw a gazetteer overlay source: a boundary line and a label
 * or dot layer per switch, and one hidden extents layer.
 *
 * `basemapLayers` are the basemap's composed layers, from which a paired switch copies its label style.
 * A source layer the tile set lacks gets no style layer, so MapLibre logs no missing-layer error.
 */
export function gazetteerOverlayLayers(
	source: string,
	sourceLayers: ReadonlySet<string>,
	basemapLayers: readonly LayerSpecification[]
): LayerSpecification[] {
	const lines: LayerSpecification[] = []
	const marks: LayerSpecification[] = []

	for (const toggle of GAZETTEER_PLACETYPE_TOGGLES) {
		if (sourceLayers.has(GazetteerOverlaySourceLayer.boundaries)) {
			lines.push({
				id: `${source}-${toggle.key}-boundaries`,
				type: "line",
				source,
				"source-layer": GazetteerOverlaySourceLayer.boundaries,
				filter: placetypeFilter(toggle),
				metadata: toggleMetadata(source, toggle),
				layout: { visibility: visibility(toggle.visible) },
				paint: {
					"line-color": OVERLAY_LINE_COLOR,
					"line-opacity": 0.8,
					"line-width": ["interpolate", ["linear"], ["zoom"], 2, toggle.lineWidth / 3, 12, toggle.lineWidth],
				},
			} satisfies LineLayerSpecification)
		}

		if (!sourceLayers.has(GazetteerOverlaySourceLayer.points)) continue

		if (!toggle.labels) {
			marks.push({
				id: `${source}-${toggle.key}-points`,
				type: "circle",
				source,
				"source-layer": GazetteerOverlaySourceLayer.points,
				filter: placetypeFilter(toggle),
				metadata: toggleMetadata(source, toggle),
				layout: { visibility: visibility(toggle.visible) },
				paint: {
					"circle-color": OVERLAY_LINE_COLOR,
					"circle-radius": 3,
					"circle-stroke-color": "#ffffff",
					"circle-stroke-width": 1,
				},
			} satisfies CircleLayerSpecification)

			continue
		}

		const base = basemapLayers.find((layer) => layer.id === toggle.basemapLabel)

		marks.push(base?.type === "symbol" ? copiedLabelLayer(base, source, toggle) : ownLabelLayer(source, toggle))
	}

	if (sourceLayers.has(GazetteerOverlaySourceLayer.extents)) {
		lines.push({
			id: `${source}-extents`,
			type: "line",
			source,
			"source-layer": GazetteerOverlaySourceLayer.extents,
			metadata: toggleMetadata(source, { key: "extents", label: "Stored extents", visible: false }),
			layout: { visibility: "none" },
			paint: {
				"line-color": OVERLAY_LINE_COLOR,
				"line-opacity": 0.5,
				"line-width": 0.75,
				"line-dasharray": [2, 2],
			},
		} satisfies LineLayerSpecification)
	}

	// Lines draw under every label, so a boundary never covers a name.
	// MapLibre places labels from the top of the stack down, so the labels stack
	// in the basemap's placement order.
	return [...lines, ...marks.toSorted((a, b) => labelStackIndex(a.id, source) - labelStackIndex(b.id, source))]
}

/**
 * The style layers that draw a postcode overlay source, hidden until switched on.
 *
 * A postcode label uses the house-number color, because a postcode is part of
 * an address rather than a place name.
 */
export function gazetteerPostcodeLayers(source: string, sourceLayers: ReadonlySet<string>): LayerSpecification[] {
	const metadata = toggleMetadata(source, { key: "postcodes", label: "Postcodes", visible: false })
	const layers: LayerSpecification[] = []

	if (sourceLayers.has(GazetteerOverlaySourceLayer.postcodeBoundaries)) {
		layers.push({
			id: `${source}-boundaries`,
			type: "line",
			source,
			"source-layer": GazetteerOverlaySourceLayer.postcodeBoundaries,
			metadata,
			layout: { visibility: "none" },
			paint: {
				"line-color": GuideMapPalette.houseNumber,
				"line-opacity": 0.7,
				"line-width": 0.8,
				"line-dasharray": [3, 2],
			},
		} satisfies LineLayerSpecification)
	}

	if (sourceLayers.has(GazetteerOverlaySourceLayer.postcodePoints)) {
		layers.push({
			id: `${source}-labels`,
			type: "symbol",
			source,
			"source-layer": GazetteerOverlaySourceLayer.postcodePoints,
			metadata,
			layout: {
				"text-field": ["get", "name"],
				"text-font": [MAP_FONT_REGULAR],
				"text-size": ["interpolate", ["linear"], ["zoom"], 12, 9, 16, 11],
				"text-letter-spacing": 0.05,
				"text-optional": true,
				visibility: "none",
			},
			paint: {
				"text-color": GuideMapPalette.houseNumber,
				"text-halo-color": "#ffffff",
				"text-halo-width": 1.2,
			},
		} satisfies SymbolLayerSpecification)
	}

	return layers
}

/**
 * The basemap layers with each one a shown overlay switch draws in place of set hidden.
 */
export function hideReplacedLayers(layers: readonly LayerSpecification[]): LayerSpecification[] {
	const replaced = new Set(
		layers.flatMap((layer) => {
			const toggle = resolveLayerToggle(layer)
			const shown = !layer.layout || !("visibility" in layer.layout) || layer.layout.visibility !== "none"

			return toggle && toggle !== "canvas" && shown ? (toggle.replaces ?? []) : []
		})
	)

	return layers.map((layer) =>
		replaced.has(layer.id)
			? ({ ...layer, layout: { ...layer.layout, visibility: "none" } } as LayerSpecification)
			: layer
	)
}
