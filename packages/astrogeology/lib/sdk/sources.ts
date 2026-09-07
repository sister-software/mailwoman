/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The source products, typed. A nomenclature archive is regenerated nightly by USGS and is pinned by SNAPSHOT: the
 *   fetch records the day's bytes and SHA-256 in the lock, and the build reads only the locked snapshot. A DEM is a
 *   stable product pinned by URL and byte count; the first fetch writes its SHA-256 and every later fetch refuses a
 *   change. Every row is public domain (USGS `<useconst>`).
 */

import type { BuildableBodyID } from "#bodies"

export type PlanetarySourceKind = "nomenclature" | "dem"

export interface PlanetarySource {
	id: string
	body: BuildableBodyID
	kind: PlanetarySourceKind
	url: string
	/**
	 * The product's byte count where the product is stable; `null` for a nightly archive, whose size moves by a few
	 * kilobytes between snapshots.
	 */
	expectedBytes: number | null
	pinned: "snapshot" | "product"
	license: "public-domain"
}

/**
 * The four products the pipeline reads, as measured on 2026-09-07: the nomenclature centre-point shapefiles (9,086 Moon
 * points, 2,052 Mars points, longitude 0..360) and the LOLA 118 m and MOLA 463 m global DEMs.
 */
export const SOURCES = {
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

export type PlanetarySourceID = keyof typeof SOURCES

/**
 * The source of one kind for one body.
 */
export function sourceFor(body: BuildableBodyID, kind: PlanetarySourceKind): PlanetarySource {
	const id = `${body}-${kind}` as PlanetarySourceID

	return SOURCES[id]
}
