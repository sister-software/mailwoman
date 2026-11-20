// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `bbox` parameter `/search` and `/collections/{collectionId}/items` share.
 */

import { isValidLatitude, isValidLongitude } from "@mailwoman/spatial/coordinate/bounds"

/**
 * A `[minLon, minLat, maxLon, maxLat]` box in WGS 84 degrees.
 */
export type OGCBBox = readonly [number, number, number, number]

/**
 * The count of numbers in a two-dimensional `bbox`: two longitudes and two latitudes.
 */
const BBOX_CORNERS = 4

/**
 * The count of numbers in a three-dimensional `bbox`, which adds a minimum and maximum height.
 */
const BBOX_CORNERS_WITH_HEIGHT = 6

/**
 * Parse a `bbox` value.
 *
 * @param options.withHeight Admit the six-number form of OGC API Features Part 1,
 * Requirement 23 D: `minLon,minLat,minHeight,maxLon,maxLat,maxHeight`.
 * Every feature here is a point without a height, so the returned box keeps the
 * longitudes and latitudes and drops the heights.
 * @returns The box, or a message that states the problem with the value.
 */
export function parseBBox(raw: string, options: { withHeight?: boolean } = {}): OGCBBox | string {
	const parts = raw.split(",").map((part) => part.trim())
	const numbers = parts.map((part) => (part === "" ? Number.NaN : Number(part)))
	const sixNumbers = options.withHeight === true && numbers.length === BBOX_CORNERS_WITH_HEIGHT

	if ((numbers.length !== BBOX_CORNERS && !sixNumbers) || !numbers.every(Number.isFinite)) {
		return options.withHeight
			? "bbox: four or six comma-separated numbers are required, minLon,minLat,maxLon,maxLat or minLon,minLat,minHeight,maxLon,maxLat,maxHeight"
			: "bbox: four comma-separated numbers are required, minLon,minLat,maxLon,maxLat"
	}

	if (sixNumbers && numbers[2]! > numbers[5]!) return "bbox: the minimum height exceeds the maximum"

	const [minLon, minLat, maxLon, maxLat] = (
		sixNumbers ? [numbers[0], numbers[1], numbers[3], numbers[4]] : numbers
	) as [number, number, number, number]

	if (!isValidLongitude(minLon) || !isValidLongitude(maxLon)) return "bbox: longitudes must lie in [-180, 180]"

	if (!isValidLatitude(minLat) || !isValidLatitude(maxLat)) return "bbox: latitudes must lie in [-90, 90]"

	if (minLat > maxLat) return "bbox: the minimum latitude exceeds the maximum"

	return [minLon, minLat, maxLon, maxLat]
}

/**
 * Whether a point lies inside the box, edges included.
 *
 * A box whose minimum longitude exceeds its maximum crosses the antimeridian, as OGC API boxes may.
 */
export function searchBoxContains([minLon, minLat, maxLon, maxLat]: OGCBBox, lon: number, lat: number): boolean {
	if (lat < minLat || lat > maxLat) return false

	return minLon <= maxLon ? lon >= minLon && lon <= maxLon : lon >= minLon || lon <= maxLon
}
