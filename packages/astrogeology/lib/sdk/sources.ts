/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed records describe the source products. USGS regenerates the nomenclature archive nightly.
 *   A snapshot lock records the downloaded bytes and SHA-256. Builds read only the locked snapshot.
 *   Each DEM is pinned by URL and byte count. The first fetch records its SHA-256. Later fetches
 *   verify that checksum. Every row is public domain (USGS `<useconst>`).
 */

import type { BuildableBodyID } from "#bodies"

export type PlanetarySourceKind = "nomenclature" | "dem"

export interface PlanetarySource {
	id: string
	body: BuildableBodyID
	kind: PlanetarySourceKind
	url: string
	/**
	 * The byte count for a stable product.
	 *
	 * Nightly archives use `null` because their sizes vary by a few kilobytes between snapshots.
	 */
	expectedBytes: number | null
	pinned: "snapshot" | "product"
	license: "public-domain"
}

/**
 * The four products the pipeline reads, as measured on 2026-09-07: the nomenclature
 * center-point shapefiles (9,086 Moon points, 2,052 Mars points, longitude 0..360)
 * and the lola 118 m and mola 463 m global DEMs.
 */
const SOURCES = {
	"moon-nomenclature": {
		id: "moon-nomenclature",
		body: "moon",
		kind: "nomenclature",
		url: "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip",
		expectedBytes: null,
		pinned: "snapshot",
		license: "public-domain",
	},
	"mars-nomenclature": {
		id: "mars-nomenclature",
		body: "mars",
		kind: "nomenclature",
		url: "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.zip",
		expectedBytes: null,
		pinned: "snapshot",
		license: "public-domain",
	},
	"moon-dem": {
		id: "moon-dem",
		body: "moon",
		kind: "dem",
		url: "https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif",
		expectedBytes: 8_494_203_833,
		pinned: "product",
		license: "public-domain",
	},
	"mars-dem": {
		id: "mars-dem",
		body: "mars",
		kind: "dem",
		url: "https://planetarymaps.usgs.gov/mosaic/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif",
		expectedBytes: 2_125_771_142,
		pinned: "product",
		license: "public-domain",
	},
} as const satisfies Record<string, PlanetarySource>

type PlanetarySourceID = keyof typeof SOURCES

/**
 * The source of one kind for one body.
 */
export function sourceFor(body: BuildableBodyID, kind: PlanetarySourceKind): PlanetarySource {
	const id = `${body}-${kind}` as PlanetarySourceID

	return SOURCES[id]
}
