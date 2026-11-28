// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads places out of a Photon index as landmark rows, for the build-local OpenStreetMap place layer.
 *
 *   Each row keeps the importance Photon holds for its place, so the reader
 *   ranks namesakes the way Photon does.
 *   The data is ODbL, so the database stays out of every published package.
 */

import { OSM_LANDMARK_PREFIX } from "@mailwoman/core/resolver"
import type { OutcomeAssertion, OutcomeEvidenceTable } from "@mailwoman/gazetteer/whosonfirst/outcomes/evidence"
import { landmarkNameKey, type LandmarkNameTable } from "@mailwoman/resolver-wof-sqlite/landmark/rows"
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
	/**
	 * The OpenStreetMap tag key the place was indexed under, such as `leisure`.
	 */
	osm_key?: string
	/**
	 * The tag's value, such as `park`.
	 */
	osm_value?: string
	name?: Record<string, string>
	coordinate?: { lat?: number; lon?: number }
	countrycode?: string
	importance?: number
}

/**
 * The `qid` column value of a document's rows, or `null` for a document without an OSM type and ID.
 */
export function osmPlaceKey(document: PhotonPlaceDocument): string | null {
	return document.osm_type && document.osm_id ? `${OSM_LANDMARK_PREFIX}${document.osm_type}${document.osm_id}` : null
}

/**
 * A place's outcome assertions: each member the definitions' OSM evidence maps its tag to.
 *
 * A tag whose evidence implies zero identity members takes `venue`.
 * Every class in {@link OSM_PLACE_CLASSES} outside `place` names a site a visitor enters,
 * and the spec maps both `place` values the layer selects.
 *
 * @throws When the document lacks its tag, the type field the evidence is keyed by.
 */
export function osmPlaceAssertions(
	document: PhotonPlaceDocument,
	table: OutcomeEvidenceTable,
	identityKinds: ReadonlySet<string>
): OutcomeAssertion[] {
	if (!document.osm_key || !document.osm_value) {
		throw new TypeError(`${osmPlaceKey(document) ?? "a document"} has no osm_key or osm_value to map to an outcome.`)
	}

	const tag = `${document.osm_key}=${document.osm_value}`
	const assertions = table.assertionsFor("osm", tag)

	if (!assertions.some((assertion) => assertion.stance === "asserts" && identityKinds.has(assertion.outcome))) {
		assertions.push({ outcome: "venue", stance: "asserts", src: `osm-places:class=${tag}` })
	}

	return assertions
}

/**
 * The rows one document contributes: each distinct name key among its names and translations.
 *
 * Every row reads as a weak claim, because a town keeps a name it holds in the gazetteer.
 * A document with no name, ID or coordinate contributes no row.
 */
export function osmPlaceRows(document: PhotonPlaceDocument): LandmarkNameTable[] {
	const { name: names, coordinate } = document
	const name = names?.["en"] ?? names?.["default"]
	const qid = osmPlaceKey(document)

	if (!names || !name || !qid || typeof coordinate?.lat !== "number" || typeof coordinate.lon !== "number") {
		return []
	}

	const rows = new Map<string, LandmarkNameTable>()

	for (const written of Object.values(names)) {
		const key = landmarkNameKey(written)

		if (key.length < 2 || rows.has(key)) continue

		rows.set(key, {
			name_key: key,
			qid,
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
