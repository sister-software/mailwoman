/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turn an outline into the H3 cell set a coverage claim may be keyed to, conservatively: a cell
 *   must have its whole `gridDisk(cell, 1)` and all six boundary vertices inside the outline.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { cellToBoundary, gridDisk, polygonToCells } from "h3-js"

import { arealPolygons, geometryContains, type ParsedGeometry, type PolygonRings } from "#geometries/polygon"
import { shortCellToInt, type H3Cell } from "#h3/cell"

/**
 * The rings a polyfill walks: every polygon's outer ring, with holes deliberately not
 * subtracted because the interior test re-checks vertices against the full geometry.
 */
function outerRings(geometry: ParsedGeometry): PolygonRings {
	const polygons = arealPolygons(geometry)

	if (!polygons) {
		throw new Error(`coverage region: expected a Polygon or MultiPolygon geometry, got ${stringifyJSON(geometry.type)}`)
	}

	return polygons.filter((rings) => rings.length).map((rings) => rings[0]!)
}

/**
 * The outline's bounding rectangle, for pre-clipping a reference inventory that can only
 * be probed by range — a coarse filter that contains the outline and is never the outline.
 */
export function geometryBBox(geometry: ParsedGeometry): {
	minLon: number
	minLat: number
	maxLon: number
	maxLat: number
} {
	let minLon = Infinity
	let minLat = Infinity
	let maxLon = -Infinity
	let maxLat = -Infinity

	for (const ring of outerRings(geometry)) {
		for (const [lon, lat] of ring) {
			if (lon! < minLon) {
				minLon = lon!
			}

			if (lon! > maxLon) {
				maxLon = lon!
			}

			if (lat! < minLat) {
				minLat = lat!
			}

			if (lat! > maxLat) {
				maxLat = lat!
			}
		}
	}

	if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) {
		throw new TypeError("coverage region: geometry carries no coordinates to bound")
	}

	return { minLon, minLat, maxLon, maxLat }
}

/**
 * Every cell whose centre falls inside `geometry`, at `resolution` — the raw
 * polyfill that {@link interiorCoverageCells} narrows.
 */
export function regionCoverageCells(geometry: ParsedGeometry, resolution: number): H3Cell[] {
	const cells = new Set<string>()

	for (const ring of outerRings(geometry)) {
		// polygonToCells's default (non-GeoJSON) coordinate order is [lat, lng] per vertex.
		const latLng = ring.map(([lon, lat]) => [lat!, lon!])

		for (const cell of polygonToCells(latLng, resolution)) {
			cells.add(cell)
		}
	}

	return [...cells] as H3Cell[]
}

/**
 * The cells of {@link regionCoverageCells} that lie wholly inside `geometry`.
 */
export function interiorCoverageCells(geometry: ParsedGeometry, resolution: number): H3Cell[] {
	const polyfilled = new Set<string>(regionCoverageCells(geometry, resolution))
	const interior: H3Cell[] = []

	for (const cell of polyfilled) {
		if (!gridDisk(cell, 1).every((neighbor) => polyfilled.has(neighbor))) continue

		const vertices = cellToBoundary(cell) as number[][]

		if (!vertices.every(([lat, lon]) => geometryContains(geometry, lon!, lat!))) continue

		interior.push(cell as H3Cell)
	}

	return interior
}

/**
 * The 48-bit short-cell form of {@link interiorCoverageCells}, as a membership set —
 * the shape both a row clipper and a coverage writer probe.
 */
export function interiorCoverageCellSet(geometry: ParsedGeometry, resolution: number): Set<number> {
	return new Set(interiorCoverageCells(geometry, resolution).map((cell) => shortCellToInt(cell)))
}
