/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A self-contained basemap style over the Protomaps planet tileset: one vector source and the
 *   `@protomaps/basemaps` layers, with no terrain, bathymetry or buildings tileset.
 *
 *   `StyleSpecificationComposer` builds Earth's style. That style adds raster DEM sources, a GeoJSON land underlay, sky
 *   and light. A client that renders only vector tiles, such as QGIS, or a page that wants a plain basemap, reads this
 *   style instead.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec"
import { type Flavor, layers, namedFlavor } from "@protomaps/basemaps"

import { MailwomanBaseFlavor, MailwomanBaseTileSetID, MailwomanDarkFlavor } from "#base/theme"
import { PROTOMAPS_GLYPHS_URL, protomapsSpriteURL, type ProtomapsSpriteName } from "#styles/assets"
import type { TileJSON } from "#tiles/schema"

/**
 * The basemap styles a caller selects by name: the Protomaps stock flavors and the two Mailwoman themes.
 */
export const BASEMAP_STYLE_NAMES = [
	"light",
	"dark",
	"white",
	"grayscale",
	"black",
	"mailwoman",
	"mailwoman-dark",
] as const

export type BasemapStyleName = (typeof BASEMAP_STYLE_NAMES)[number]

export function isBasemapStyleName(value: string): value is BasemapStyleName {
	return (BASEMAP_STYLE_NAMES as readonly string[]).includes(value)
}

/**
 * The flavor and sprite sheet of each style in {@linkcode BASEMAP_STYLE_NAMES}.
 *
 * A Mailwoman theme reads the sprite of the stock flavor it starts from.
 */
const BASEMAP_STYLES: Record<BasemapStyleName, { flavor: () => Flavor; sprite: ProtomapsSpriteName }> = {
	light: { flavor: () => namedFlavor("light"), sprite: "light" },
	dark: { flavor: () => namedFlavor("dark"), sprite: "dark" },
	white: { flavor: () => namedFlavor("white"), sprite: "white" },
	grayscale: { flavor: () => namedFlavor("grayscale"), sprite: "grayscale" },
	black: { flavor: () => namedFlavor("black"), sprite: "black" },
	mailwoman: { flavor: () => MailwomanBaseFlavor, sprite: "light" },
	"mailwoman-dark": { flavor: () => MailwomanDarkFlavor, sprite: "dark" },
}

/**
 * A label language: a lowercase ISO 639 code, optionally followed by subtags,
 * such as `en`, `ja` or `zh-Hans`.
 */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

export function isBasemapLanguage(value: string): boolean {
	return LANGUAGE_TAG.test(value)
}

export interface BasemapStyleOptions {
	/**
	 * The planet tileset's TileJSON.
	 *
	 * Its tile URLs, zoom range, bounds and attribution go into the style's source,
	 * so the style loads without a second request for the TileJSON.
	 */
	tileJSON: Pick<TileJSON, "tiles" | "minzoom" | "maxzoom" | "bounds" | "attribution">
	style?: BasemapStyleName
	/**
	 * The label language.
	 *
	 * @defaultValue `"en"`
	 */
	lang?: string
}

/**
 * A MapLibre style for the Protomaps planet tileset in one of {@linkcode BASEMAP_STYLE_NAMES}.
 *
 * @throws on a language tag outside {@linkcode isBasemapLanguage}.
 */
export function createBasemapStyle(options: BasemapStyleOptions): StyleSpecification {
	const name = options.style ?? "light"
	const lang = options.lang ?? "en"

	if (!isBasemapLanguage(lang)) throw new Error(`createBasemapStyle: invalid language tag ${stringifyJSON(lang)}`)

	const { flavor, sprite } = BASEMAP_STYLES[name]
	const { tiles, minzoom, maxzoom, bounds, attribution } = options.tileJSON

	return {
		version: 8,
		name: `Mailwoman ${name}`,
		glyphs: PROTOMAPS_GLYPHS_URL,
		sprite: protomapsSpriteURL(sprite),
		sources: {
			[MailwomanBaseTileSetID]: {
				type: "vector",
				tiles,
				minzoom,
				maxzoom,
				bounds,
				...(attribution ? { attribution } : {}),
			},
		},
		layers: layers(MailwomanBaseTileSetID, flavor(), { lang }),
	}
}
