/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turn an outline into the H3 cell set a coverage claim may be keyed to.
 *
 *   Polyfilling a rectangle is right for a rectangular extract and wrong for a region: a region is
 *   clipped to a polygon, so a rectangle polyfilled over it claims survey across whatever the rectangle
 *   overhangs. These helpers answer the narrower question — which cells lie wholly INSIDE the outline —
 *   and they answer conservatively, because the cells they return are the ones a completeness claim will
 *   be written to.
 *
 *   Interior is two tests, both required. A cell must have its whole `gridDisk(cell, 1)` inside the
 *   outline's own polyfill, and all six of its boundary vertices inside the polygon. The first removes the
 *   polyfill's edge ring (H3's polyfill keeps a cell whose CENTRE is inside, so an edge cell can be half
 *   outside); the second catches a boundary that re-enters between two neighbours. Neither test alone is
 *   sufficient, and the cost of being wrong is asymmetric — a cell wrongly called interior claims a survey
 *   over ground the source never covered.
 *
 *   Measured on the Île-de-France région (OSM relation 8649, admin_level 4) at res 6: 371 polyfilled
 *   cells, 290 interior, holding 3,248 of the extract's 3,308 `amenity=pharmacy` features.
 */

import { cellToBoundary, gridDisk, polygonToCells } from "h3-js"

import { arealPolygons, geometryContains, type ParsedGeometry, type PolygonRings } from "#geometries/polygon"
import { shortCellToInt, type H3Cell } from "#h3/cell"

/**
 * The rings a polyfill walks: every polygon's OUTER ring. Holes are deliberately not subtracted here — a hole would
 * only ever remove cells, and the interior test below re-checks every returned cell's vertices against the full
 * geometry (holes included), so a hole cannot survive into the result.
 */
function outerRings(geometry: ParsedGeometry): PolygonRings {
	const polygons = arealPolygons(geometry)

	if (!polygons) {
		throw new Error(
			`coverage region: expected a Polygon or MultiPolygon geometry, got ${JSON.stringify(geometry.type)}`
		)
	}

	return polygons.filter((rings) => rings.length).map((rings) => rings[0]!)
}

/**
 * The outline's bounding rectangle, for pre-clipping a reference inventory that can only be probed by range.
 *
 * A coarse filter and nothing more — it CONTAINS the outline and is never the outline. The exact clip is
 * {@link interiorCoverageCellSet}; using this rectangle as the region would claim survey over every corner the outline
 * does not reach.
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
 * Every cell whose CENTRE falls inside `geometry`, at `resolution`. The raw polyfill — {@link interiorCoverageCells}
 * narrows it.
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
 * The cells of {@link regionCoverageCells} that lie wholly inside `geometry` — see the module docstring for why both
 * tests are applied.
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
 * The 48-bit short-cell form of {@link interiorCoverageCells}, as a membership set — the shape both a row clipper and a
 * coverage writer probe.
 */
export function interiorCoverageCellSet(geometry: ParsedGeometry, resolution: number): Set<number> {
	return new Set(interiorCoverageCells(geometry, resolution).map((cell) => shortCellToInt(cell)))
}
