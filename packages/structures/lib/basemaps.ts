/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The register sources each map layer reads, and the credits a map must show for them.
 */

import { STRUCTURE_SOURCE_REGISTER } from "#register"
import type { StructureSourceRegister } from "#types"

/**
 * The basemap tilesets a map can load.
 */
export const Basemap = {
	/**
	 * The Protomaps v4 planet build served from `tiles.mailwoman.ai/basemap-v4.json`.
	 *
	 * Its TileJSON describes it as derived from OpenStreetMap and Natural Earth.
	 */
	ProtomapsV4: "protomaps-v4",
	/**
	 * A `mailwoman/basemaps` regional build, such as `protomaps/builds/japan-2026-10-22.pmtiles`.
	 */
	MailwomanBuild: "mailwoman-build",
} as const

/**
 * One of the {@link Basemap} values.
 */
export type Basemap = (typeof Basemap)[keyof typeof Basemap]

/**
 * The register sources each basemap's tiles are built from.
 */
export const BASEMAP_INPUTS: Readonly<Record<Basemap, readonly string[]>> = {
	[Basemap.ProtomapsV4]: ["international-osm", "international-natural-earth"],
	[Basemap.MailwomanBuild]: [
		"international-osm",
		"international-overture-buildings",
		"international-overture-base",
		"international-meta-wri-chm",
		"international-daylight",
		"international-natural-earth",
	],
}

/**
 * The register sources the hillshade layer reads.
 */
export const HILLSHADE_INPUTS: readonly string[] = ["international-terrain-tiles"]

/**
 * The register sources of the 3D city models the map draws over the basemap.
 */
export const CITY_MODEL_INPUTS: readonly string[] = ["jp-plateau-lod2-tilesets"]

/**
 * A credit a map shows for one source: the attribution text and the page it links to.
 */
export interface MapCredit {
	sourceID: string
	text: string
	url: string
}

/**
 * The credits for a set of register sources, one per source, in the order given.
 *
 * @throws When a source id is missing from the register or its record lacks attribution,
 * because a map that draws a source must show a credit for it.
 */
export function creditsFor(
	sourceIDs: readonly string[],
	register: StructureSourceRegister = STRUCTURE_SOURCE_REGISTER
): MapCredit[] {
	const credits: MapCredit[] = []

	for (const sourceID of new Set(sourceIDs)) {
		const source = register.sources.find((entry) => entry.sourceID === sourceID)

		if (!source) throw new Error(`source ${sourceID} is not in the structure-source register`)

		if (!source.attribution) throw new Error(`source ${sourceID} records no attribution text`)

		credits.push({ sourceID, text: source.attribution, url: source.attributionURL ?? source.datasetURL })
	}

	return credits
}
