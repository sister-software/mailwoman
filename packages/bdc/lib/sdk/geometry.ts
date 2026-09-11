/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Centroid and TIGER lookup utilities for BDC block geometry.
 */

import { tryParsingJSON } from "@mailwoman/core/json"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"

/**
 * One GeoJSON `Polygon`/`MultiPolygon` geometry, as stored in `tabblock20.geometry` (see `tiger/sdk/schema.ts`).
 */
interface GeoJSONPolygon {
	type: "Polygon"
	coordinates: number[][][]
}

interface GeoJSONMultiPolygon {
	type: "MultiPolygon"
	coordinates: number[][][][]
}

/**
 * Area-weighted (shoelace) centroid of a GeoJSON `Polygon`/`MultiPolygon`'s EXTERIOR ring(s), area-weighted across
 * rings for a MultiPolygon. Interior rings/holes are still ignored — a hole moves a block's centroid far less than the
 * vertex-density skew this replaces, and only 1.0% of measured blocks carry one.
 *
 * This REPLACED the first version's vertex-average, whose "same res-9 cell for all but pathological shapes" claim was
 * falsified by measurement over every real TIGER 2020 block in LA + Orange county (118,360 blocks, 2026-08-11): the
 * vertex-average landed in a different res-9 cell for 11.6% of blocks, p99 displacement 286 m (past the ~174 m cell
 * edge), max 3.7 km — the tail is TIGER's elongated rural/mountain blocks, whose boundary vertices cluster on the
 * squiggly natural edge and drag a vertex-average toward it.
 *
 * A degenerate geometry with zero total ring area (a sliver the shoelace annihilates) falls back to the vertex average
 * — a weaker answer beats none, and the fallback is exactly the old behavior.
 *
 * Returns `undefined` for anything that doesn't parse as one of the two geometry types (including `null` geometry).
 */
export function geometryCentroid(geometryJSON: string | null): { lat: number; lon: number } | undefined {
	if (!geometryJSON) return undefined

	const geometry = tryParsingJSON<GeoJSONPolygon | GeoJSONMultiPolygon>(geometryJSON)

	if (!geometry) return undefined

	const exteriorRings: number[][][] =
		geometry.type === "Polygon"
			? [geometry.coordinates[0] ?? []]
			: geometry.type === "MultiPolygon"
				? geometry.coordinates.map((polygon) => polygon[0] ?? [])
				: []

	let totalArea = 0
	let weightedLon = 0
	let weightedLat = 0
	let sumLon = 0
	let sumLat = 0
	let count = 0

	for (const ring of exteriorRings) {
		let ringArea = 0
		let ringLon = 0
		let ringLat = 0

		for (let i = 0; i < ring.length - 1; i++) {
			const [x1, y1] = ring[i]!
			const [x2, y2] = ring[i + 1]!

			if (typeof x1 !== "number" || typeof y1 !== "number" || typeof x2 !== "number" || typeof y2 !== "number") {
				continue
			}

			const cross = x1 * y2 - x2 * y1
			ringArea += cross
			ringLon += (x1 + x2) * cross
			ringLat += (y1 + y2) * cross
			// The vertex-average fallback accumulates alongside — one pass, both answers.
			sumLon += x1
			sumLat += y1

			count++
		}

		ringArea /= 2

		if (ringArea === 0) continue

		const weight = Math.abs(ringArea)
		totalArea += weight
		weightedLon += (ringLon / (6 * ringArea)) * weight
		weightedLat += (ringLat / (6 * ringArea)) * weight
	}

	if (totalArea > 0) {
		return { lat: weightedLat / totalArea, lon: weightedLon / totalArea }
	}

	if (count === 0) return undefined

	return { lat: sumLat / count, lon: sumLon / count }
}

/**
 * The production `blockCentroids` supplier: opens the TIGER blocks database READ-ONLY and probes `tabblock20.GEOID`
 * (uppercase) per lookup, decoding its GeoJSON `geometry` column via {@linkcode geometryCentroid}. The factory awaits
 * its read-only open; the per-lookup probe and the `BuildBDCOptions.blockCentroids` interface stay synchronous — a
 * plain sync function (the same sync-by-interface discipline AGENTS.md documents for the resolver ladder), so the
 * returned closure uses `node:sqlite`'s raw `.prepare()`/`.get()` directly rather than Kysely. The connection is left
 * open for the caller's process lifetime (a read-path lookup, not a build) — same lifecycle as the resolver-wof-sqlite
 * lookups.
 */
export async function createTIGERBlockCentroidLookup(
	tigerDBPath: string
): Promise<(geoid: string) => { lat: number; lon: number } | undefined> {
	const db = await openBuiltClient(tigerDBPath)
	const stmt = db.prepare("SELECT geometry FROM tabblock20 WHERE GEOID = ?")

	return (geoid: string) => {
		const row = stmt.get(geoid) as { geometry: string | null } | undefined

		return row ? geometryCentroid(row.geometry) : undefined
	}
}
