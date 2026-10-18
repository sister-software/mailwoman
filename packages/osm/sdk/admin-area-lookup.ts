/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which named administrative area contains a point, for the address points of an extract whose mappers
 *   left `addr:city` off.
 *
 *   In Serbia's extract most address points carry no `addr:city`, while the settlement each one stands in
 *   is drawn as an `admin_level=9` boundary in the same file. A lookup over those boundaries reads the
 *   settlement from the point's position rather than from a tag.
 *
 *   The boundaries are bucketed by a grid over their bounding boxes, so a point is ray-cast only against
 *   the few areas whose box covers its cell. Where areas nest at one level, the one with the smallest box
 *   is the answer.
 */

import { geometryBBox, geometryContains } from "@mailwoman/spatial"

import type { OSMAdminArea } from "#sdk/extract/boundary"

/**
 * Grid cell size in degrees.
 */
const CELL = 0.1

interface IndexedArea {
	area: OSMAdminArea
	minLon: number
	minLat: number
	maxLon: number
	maxLat: number
	boxArea: number
}

function cellKey(column: number, row: number): number {
	return row * 10_000 + column
}

/**
 * Returns a lookup that answers the smallest area among `areas` containing a point,
 * or `null` when none does.
 */
export function createAdminAreaLookup(
	areas: readonly OSMAdminArea[]
): (lon: number, lat: number) => OSMAdminArea | null {
	const cells = new Map<number, IndexedArea[]>()
	const column = (lon: number): number => Math.floor((lon + 180) / CELL)
	const row = (lat: number): number => Math.floor((lat + 90) / CELL)

	for (const area of areas) {
		const { minLon, minLat, maxLon, maxLat } = geometryBBox(area.geometry)

		if (!Number.isFinite(minLon)) continue

		const indexed: IndexedArea = {
			area,
			minLon,
			minLat,
			maxLon,
			maxLat,
			boxArea: (maxLon - minLon) * (maxLat - minLat),
		}

		for (let c = column(minLon); c <= column(maxLon); c++) {
			for (let r = row(minLat); r <= row(maxLat); r++) {
				const key = cellKey(c, r)
				const bucket = cells.get(key)

				if (bucket) {
					bucket.push(indexed)
				} else {
					cells.set(key, [indexed])
				}
			}
		}
	}

	for (const bucket of cells.values()) {
		bucket.sort((a, b) => a.boxArea - b.boxArea)
	}

	return (lon, lat) => {
		const bucket = cells.get(cellKey(column(lon), row(lat)))

		if (!bucket) return null

		for (const candidate of bucket) {
			if (lon < candidate.minLon || lon > candidate.maxLon || lat < candidate.minLat || lat > candidate.maxLat) continue

			if (geometryContains(candidate.area.geometry, lon, lat) === true) return candidate.area
		}

		return null
	}
}
