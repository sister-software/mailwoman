/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LayerSpecification, SourceSpecification } from "@maplibre/maplibre-gl-style-spec"
import type { LightSpecification, SkySpecification, StyleSpecification, TerrainSpecification } from "maplibre-gl"

import { BaseLayers } from "#base/layers"
import { createTerrainDEMSource, HillshadeTileSetID } from "#base/terrain"
import {
	LayerSpecificationList,
	type LayerSpecificationListInput,
	type LayerSpecificationListItem,
} from "#styles/layers"
import type { TileSetSourceRecord } from "#styles/sources"

//#endregion

//#region Spec Creators

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

//#endregion

//#region Style Composition

/**
 * The glyph host every style composed here reads fonts from. The Protomaps font set, mirrored under the public bucket
 * so a style never depends on an upstream host at render time.
 */
export const PROTOMAPS_GLYPHS_URL = "https://public.mailwoman.ai/protomaps/fonts/{fontstack}/{range}.pbf"

/**
 * The Earth sprite. It must match the basemap schema version: the v4 sprite carries the icons the v4 theme's layers
 * reference by name, so a style over a different basemap version needs a different sprite.
 */
export const PROTOMAPS_SPRITE_URL = "https://public.mailwoman.ai/protomaps/sprites/v4/light"

export interface StyleSpecificationComposition {
	sources: Record<string, SourceSpecification>
	layers?: LayerSpecificationListInput[]
	light?: Partial<LightSpecification>
	sky?: Partial<SkySpecification>
	terrain?: Partial<TerrainSpecification>
	/**
	 * The layer list every `layers` entry inserts into. Earth's basemap layers by default; a body with no roads, water or
	 * buildings brings its own.
	 */
	baseLayers?: LayerSpecification[]
	/**
	 * The `hillshade` source. Earth's terrarium DEM by default; `null` adds no such source.
	 */
	hillshadeSource?: SourceSpecification | null
	/**
	 * The sprite URL. Earth's Protomaps v4 sprite by default; `null` omits the key, for a style with no icons.
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
		}

		this.layersList = new LayerSpecificationList(spec.baseLayers ?? BaseLayers)

		for (const layer of spec.layers || []) {
			this.layersList.insert(layer)
		}
	}

	public get layers(): LayerSpecificationListItem[] {
		return Array.from(this.layersList)
	}

	toJSON(): StyleSpecification {
		const styleSpec: StyleSpecification = {
			version: 8,
			glyphs: this.glyphs,
			...(this.sprite === null ? {} : { sprite: this.sprite }),
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

//#endregion
