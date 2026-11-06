/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads places out of a Photon index as landmark rows, for the build-local OpenStreetMap place layer.
 *
 *   Each row keeps the importance Photon holds for its place, so the reader ranks namesakes the way Photon does. The data
 *   is ODbL, so the database stays out of every published package.
 */

import { OSM_LANDMARK_PREFIX } from "@mailwoman/core/resolver"
import { landmarkNameKey, type LandmarkNameTable } from "@mailwoman/resolver-wof-sqlite/landmark"
import { shortCellToInt } from "@mailwoman/spatial"
import { latLngToCell } from "@sister.software/h3"

/**
 * The H3 resolution of a row's `h3_cell`, the same as the address-point spine's.
 */
export const OSM_PLACE_H3_RESOLUTION = 9

/**
 * The classes of place a search by name reaches, as OpenStreetMap tag keys and values.
 *
 * Shops and restaurants stay with the Overture Places layer, where each row holds a confidence value.
 */
export const OSM_PLACE_CLASSES = {
	leisure: ["park", "nature_reserve", "garden", "stadium"],
	tourism: ["museum", "attraction", "viewpoint", "zoo", "theme_park", "gallery"],
	historic: ["monument", "memorial", "castle"],
	man_made: ["lighthouse"],
	amenity: ["hospital", "school", "university", "library", "theatre", "place_of_worship"],
	aeroway: ["aerodrome"],
	place: ["islet", "island"],
} as const satisfies Record<string, readonly string[]>

/**
 * The OpenSearch query selecting {@link OSM_PLACE_CLASSES}.
 */
export function osmPlaceQuery(): object {
	return {
		bool: {
			minimum_should_match: 1,
			should: Object.entries(OSM_PLACE_CLASSES).map(([key, values]) => ({
				bool: { filter: [{ term: { osm_key: key } }, { terms: { osm_value: values } }] },
			})),
		},
	}
}

/**
 * The fields of a Photon document this layer reads.
 */
export interface PhotonPlaceDocument {
	osm_type?: string
	osm_id?: number
	name?: Record<string, string>
	coordinate?: { lat?: number; lon?: number }
	countrycode?: string
	importance?: number
}

/**
 * The rows one document contributes: each distinct name key among its names and translations.
 *
 * Every row reads as a weak claim, because a town keeps a name it holds in the gazetteer.
 * A document with no name, ID or coordinate contributes no row.
 */
export function osmPlaceRows(document: PhotonPlaceDocument): LandmarkNameTable[] {
	const { name: names, coordinate, osm_type: type, osm_id: id } = document
	const name = names?.["en"] ?? names?.["default"]

	if (!names || !name || !type || !id || typeof coordinate?.lat !== "number" || typeof coordinate.lon !== "number") {
		return []
	}

	const rows = new Map<string, LandmarkNameTable>()

	for (const written of Object.values(names)) {
		const key = landmarkNameKey(written)

		if (key.length < 2 || rows.has(key)) continue

		rows.set(key, {
			name_key: key,
			qid: `${OSM_LANDMARK_PREFIX}${type}${id}`,
			name,
			kind: "venue",
			country: document.countrycode ?? null,
			latitude: coordinate.lat,
			longitude: coordinate.lon,
			sitelinks: 0,
			code: null,
			is_primary: 0,
			importance: document.importance ?? 0,
			h3_cell: shortCellToInt(latLngToCell(coordinate.lat, coordinate.lon, OSM_PLACE_H3_RESOLUTION)),
		})
	}

	return [...rows.values()]
}
