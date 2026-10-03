/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whether a point lies inside a country's outline, fast enough to test every address point of a
 *   national extract.
 *
 *   A Geofabrik extract is clipped to a polygon drawn around the country with a margin, so it holds
 *   addresses on the far side of every land border: the China extract holds Zabaykalsk and
 *   Blagoveshchensk in Russia. The extract's own boundary relation is often incomplete in the file, so
 *   the outline comes from a separate source and this module tests points against it.
 *
 *   A full country outline has tens of thousands of vertices, and a ray cast per point over twelve
 *   million points does not finish. The test grids the outline's bounding box. A cell that no edge of
 *   the outline crosses lies wholly inside or wholly outside, so the first point tested in it decides
 *   every later point. Only points in a cell an edge crosses take the exact ray cast.
 */

import { geometryContains, type ParsedGeometry } from "@mailwoman/spatial"

/**
 * Grid cell size in degrees.
 */
const CELL = 0.05

/**
 * Adds to `crossed` every cell one ring's edges pass through, plus each such cell's eight neighbors.
 *
 * Each edge is sampled at a quarter of a cell.
 * The neighbors are marked too, so an edge that clips a cell corner between
 * two samples still marks that cell.
 */
function markRing(ring: number[][], key: (lon: number, lat: number) => number, crossed: Set<number>): void {
	for (let i = 1; i < ring.length; i++) {
		const [x0, y0] = ring[i - 1]! as [number, number]
		const [x1, y1] = ring[i]! as [number, number]
		const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 4)))

		for (let s = 0; s <= steps; s++) {
			const x = x0 + ((x1 - x0) * s) / steps
			const y = y0 + ((y1 - y0) * s) / steps

			for (const dx of [-CELL, 0, CELL]) {
				for (const dy of [-CELL, 0, CELL]) {
					crossed.add(key(x + dx, y + dy))
				}
			}
		}
	}
}

/**
 * Returns a containment test for one `Polygon` or `MultiPolygon` outline.
 *
 * @throws when the geometry is not areal.
 */
export function createOutlineContainment(geometry: ParsedGeometry): (lon: number, lat: number) => boolean {
	const polygons =
		geometry.type === "Polygon"
			? [geometry.coordinates as number[][][]]
			: geometry.type === "MultiPolygon"
				? (geometry.coordinates as number[][][][])
				: null

	if (!polygons) throw new Error(`an outline must be a Polygon or MultiPolygon, got ${geometry.type}`)

	let minLon = Infinity
	let minLat = Infinity
	let maxLon = -Infinity
	let maxLat = -Infinity

	for (const polygon of polygons) {
		for (const [lon, lat] of polygon[0] ?? []) {
			minLon = Math.min(minLon, lon!)
			maxLon = Math.max(maxLon, lon!)
			minLat = Math.min(minLat, lat!)
			maxLat = Math.max(maxLat, lat!)
		}
	}

	const key = (lon: number, lat: number): number =>
		Math.floor((lat - minLat) / CELL) * 1_000_000 + Math.floor((lon - minLon) / CELL)

	const crossed = new Set<number>()

	for (const polygon of polygons) {
		for (const ring of polygon) {
			markRing(ring, key, crossed)
		}
	}

	const exact = (lon: number, lat: number): boolean => geometryContains(geometry, lon, lat) === true
	const decided = new Map<number, boolean>()

	return (lon, lat) => {
		if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false

		const cell = key(lon, lat)

		if (crossed.has(cell)) return exact(lon, lat)

		let inside = decided.get(cell)

		if (inside === undefined) {
			inside = exact(lon, lat)
			decided.set(cell, inside)
		}

		return inside
	}
}
