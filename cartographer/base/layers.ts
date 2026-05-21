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

export const BaseLayers: LayerSpecification[] = [
	...layers(MailwomanBaseTileSetID, MailwomanBaseFlavor, {
		lang: "en",
	}),

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
]
