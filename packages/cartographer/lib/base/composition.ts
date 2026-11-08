/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LayerSpecification, SourceSpecification } from "@maplibre/maplibre-gl-style-spec"
import type { LightSpecification, SkySpecification, StyleSpecification, TerrainSpecification } from "maplibre-gl"

import { BaseLayers } from "#base/layers"
import { createLandUnderlaySource, LandUnderlayTileSetID } from "#base/ocean"
import {
	BathymetryTileSetID,
	createBathymetryDEMSource,
	createTerrainDEMSource,
	HillshadeTileSetID,
} from "#base/terrain"
import { MailwomanBaseTileSetID, MailwomanBuildingsTileSetID } from "#base/theme"
import { PROTOMAPS_GLYPHS_URL, PROTOMAPS_SPRITE_URL } from "#styles/assets"
import {
	LayerSpecificationList,
	type LayerSpecificationListInput,
	type LayerSpecificationListItem,
} from "#styles/layers"
import type { TileSetSourceRecord } from "#styles/sources"

// #endregion

// #region Spec Creators

export function createLightSpec(spec?: Partial<LightSpecification>): LightSpecification {
	return {
		color: "white",
		intensity: 0.85,
		anchor: "viewport",
		position: [
			10, // Radial
			20, // Azimuthal
			-5, // Polar
		],
		...spec,
	}
}

export function createSkySpec(spec?: Partial<SkySpecification>): SkySpecification {
	return {
		"sky-color": "#000535",
		"horizon-color": "hsl(54deg 100% 16%)",
		"fog-color": "hsl(54deg 100% 5%)",
		"sky-horizon-blend": 0.75,
		"horizon-fog-blend": 0.75,
		"fog-ground-blend": 0.1,
		...spec,
	}
}

// #endregion

// #region Style Composition

export interface StyleSpecificationComposition {
	sources: Record<string, SourceSpecification>
	layers?: LayerSpecificationListInput[]
	light?: Partial<LightSpecification>
	sky?: Partial<SkySpecification>
	terrain?: Partial<TerrainSpecification>
	/**
	 * The layer list every `layers` entry inserts into.
	 *
	 * Earth's basemap layers by default.
	 * A body with no roads, water or buildings brings its own.
	 */
	baseLayers?: LayerSpecification[]
	/**
	 * The `hillshade` source.
	 *
	 * Earth's terrarium DEM by default; `null` adds no such source.
	 */
	hillshadeSource?: SourceSpecification | null
	/**
	 * The sprite URL.
	 *
	 * Earth's Protomaps v4 sprite by default; `null` omits the key, for a style with no icons.
	 */
	sprite?: string | null
	glyphs?: string
}

/**
 * A stateful class for composing a style specification.
 */
export class StyleSpecificationComposer {
	layersList: LayerSpecificationList
	light: LightSpecification
	sky: SkySpecification
	// terrain: TerrainSpecification
	sources: TileSetSourceRecord
	sprite: string | null
	glyphs: string

	constructor(spec: StyleSpecificationComposition) {
		this.light = createLightSpec(spec.light)
		this.sky = createSkySpec(spec.sky)
		this.sprite = spec.sprite === undefined ? PROTOMAPS_SPRITE_URL : spec.sprite
		this.glyphs = spec.glyphs ?? PROTOMAPS_GLYPHS_URL

		// this.terrain = {
		// 	source: TerrainTileSetID,
		// 	...spec.terrain,
		// }

		const hillshadeSource = spec.hillshadeSource === undefined ? createTerrainDEMSource() : spec.hillshadeSource

		this.sources = {
			...spec.sources,
			// [TerrainTileSetID]: createTerrainDEMSource(),
			...(hillshadeSource ? { [HillshadeTileSetID]: hillshadeSource } : {}),
			// The default base layers include the ocean layers.
			// Those layers read the bathymetry and land-underlay sources.
			...(spec.baseLayers
				? {}
				: {
						[BathymetryTileSetID]: createBathymetryDEMSource(),
						[LandUnderlayTileSetID]: createLandUnderlaySource(),
					}),
		}

		this.layersList = new LayerSpecificationList(spec.baseLayers ?? BaseLayers)

		for (const layer of spec.layers || []) {
			this.layersList.insert(layer)
		}
	}

	/**
	 * The composed layers.
	 *
	 * Without a separate buildings tileset among the sources, the footprint layers
	 * read the basemap's `buildings` layer.
	 */
	public get layers(): LayerSpecificationListItem[] {
		const layers = Array.from(this.layersList)

		if (MailwomanBuildingsTileSetID in this.sources) return layers

		return layers.map((layer) =>
			"source" in layer && layer.source === MailwomanBuildingsTileSetID
				? { ...layer, source: MailwomanBaseTileSetID }
				: layer
		)
	}

	toJSON(): StyleSpecification {
		const styleSpec: StyleSpecification = {
			version: 8,
			glyphs: this.glyphs,
			...(this.sprite ? { sprite: this.sprite } : {}),
			light: createLightSpec(this.light),
			sky: createSkySpec(this.sky),
			// terrain: this.terrain,
			sources: this.sources,
			layers: this.layers,
		}

		return styleSpec
	}

	toJS(): StyleSpecification {
		return this.toJSON()
	}
}

// #endregion
