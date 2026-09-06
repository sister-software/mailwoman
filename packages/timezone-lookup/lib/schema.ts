// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `timezone.db` read contract. Declared beside the reader and the builder that writes it, so a column added to
 *   one is a compile error against the other.
 */

/**
 * One timezone polygon: its IANA identifier, bounding box, and encoded geometry.
 */
export interface TimezonePolygonTable {
	tzid: string
	minLat: number | null
	maxLat: number | null
	minLon: number | null
	maxLon: number | null
	geom: string
}

/**
 * The tables `timezone.db` carries.
 */
export interface TimezoneDatabase {
	timezone_polygons: TimezonePolygonTable
}
