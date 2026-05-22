/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { layers } from "@protomaps/basemaps"
import { type LayerSpecification } from "maplibre-gl"
import { BuildingLayers } from "../base/buildings.js"
import { MailwomanBaseFlavor, MailwomanBaseTileSetID } from "../base/theme.js"
import { LayerID } from "../styles/layers.js"
import { HillshadeTileSetID } from "./terrain.js"

export const HillsLayerID = LayerID(HillshadeTileSetID, "hills")

/**
 * Splits `layers()` into non-label + label groups so building footprints, water outlines, and
 * hillshade sit between base geometry and labels. `@protomaps/basemaps@5.x` doesn't expose a
 * `noLabels` helper — `labelsOnly: true` gives only the label layers; subtracting that set from the
 * full list yields the non-label group.
 */
const allBaseLayers = layers(MailwomanBaseTileSetID, MailwomanBaseFlavor, { lang: "en" })
const labelLayers = layers(MailwomanBaseTileSetID, MailwomanBaseFlavor, { lang: "en", labelsOnly: true })
const labelLayerIDs = new Set(labelLayers.map((layer) => layer.id))
const nonLabelLayers = allBaseLayers.filter((layer) => !labelLayerIDs.has(layer.id))

export const BaseLayers: LayerSpecification[] = [
	...nonLabelLayers,
	{
		id: LayerID(MailwomanBaseTileSetID, "water-outline"),
		type: "line",
		source: MailwomanBaseTileSetID,
		"source-layer": "water",
		filter: ["any", ["in", "water", "river", "lake", "other"]],
		paint: {
			"line-color": "hsl(194deg 100% 30% / 0.5)",
			"line-width": 1,
		},
	},
	{
		id: HillsLayerID,
		type: "hillshade",
		source: HillshadeTileSetID,
		paint: {
			"hillshade-exaggeration": 0.25,
			"hillshade-accent-color": "hsl(240deg 100% 95%)",
			"hillshade-shadow-color": "hsl(240deg 100% 5%)",
		},
	},
	...BuildingLayers,
	...labelLayers,
]
