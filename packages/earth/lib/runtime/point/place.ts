// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A point-shaped query answers from its own decoder rather than the classifier.
 *
 *   Point shapes are coordinates, a GeoJSON point, a plus code, a DIGIPIN,
 *   an H3 cell, a geohash and a Who's On First id.
 *
 *   This module turns {@link PointReading} into the {@link ParseResult} the result panel
 *   and the map already render, so the point path adds no second renderer.
 *   The H3 reader is imported when an H3 cell is typed, because its WebAssembly
 *   binary has no place in the entry chunk.
 */

import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { MapBias } from "@mailwoman/react/map"
import { cellBounds, cellRadiusMeters, type DegreeCell } from "@mailwoman/spatial/coordinate/cell"
import { DIGIPIN_CELL_DEGREES, getLatLngFromDIGIPIN } from "@mailwoman/spatial/digipin"
import { decodePlusCode, recoverNearestPlusCode } from "@mailwoman/spatial/open-location-code"
import type { PointReading } from "@mailwoman/spatial/point/reading"
import { coordinatePairText, POINT_QUERY_DESCRIPTIONS } from "@mailwoman/spatial/point/text"

/**
 * The `kindResult.kind` of a point result, so a renderer can tell it from a classified address.
 */
export const POINT_QUERY_KIND = "point"

/**
 * Whether a result came from the point path rather than the classifier.
 */
export function isPointResult(result: ParseResult): boolean {
	return result.kindResult?.kind === POINT_QUERY_KIND
}

/**
 * A reader for a Who's On First id, supplied by the runtime that holds the gazetteer and polygon handles.
 *
 * It resolves the place, or throws with the reason the id cannot be placed,
 * so a failed read never looks like an empty answer.
 */
export type WOFPlaceReader = (id: number) => Promise<ResolvedPlaceView>

/**
 * The place a cell names: its center, its box and its half-diagonal as the uncertainty.
 */
function cellPlace(name: string, placetype: string, cell: DegreeCell): ResolvedPlaceView {
	return {
		id: 0,
		name,
		placetype,
		lat: cell.lat,
		lon: cell.lon,
		score: 1,
		bbox: cellBounds(cell),
		tier: null,
		uncertaintyM: cellRadiusMeters(cell),
	}
}

/**
 * The H3 cell's box, read from its boundary ring.
 */
async function h3Cell(cell: string): Promise<DegreeCell> {
	const { cellToBoundary, cellToLatLng, isValidCell } = await import("@sister.software/h3")

	if (!isValidCell(cell)) {
		throw new Error(`${cell} has the shape of an H3 cell but is not a valid index.`)
	}

	const [lat, lon] = cellToLatLng(cell)
	const ring = cellToBoundary(cell)
	const lats = ring.map(([ringLat]) => ringLat)
	const lons = ring.map(([, ringLon]) => ringLon)

	return {
		lat,
		lon,
		latSpanDeg: Math.max(...lats) - Math.min(...lats),
		lonSpanDeg: Math.max(...lons) - Math.min(...lons),
	}
}

/**
 * The place a point query names, or a thrown error that states why it cannot be placed.
 *
 * A short plus code recovers against the map's center, the reference Google's place
 * cards assume, and without a map it stays unplaced.
 */
export async function locatePointQuery(
	query: PointReading,
	bias: MapBias | null,
	readWOFPlace: WOFPlaceReader
): Promise<ResolvedPlaceView> {
	const label = POINT_QUERY_DESCRIPTIONS[query.recognized].label

	switch (query.kind) {
		case "coordinates":
		case "geojson_point":
			return {
				id: 0,
				name: coordinatePairText(query.latitude, query.longitude),
				placetype: label,
				lat: query.latitude,
				lon: query.longitude,
				score: 1,
				bbox: null,
				tier: null,
				uncertaintyM: 0,
			}

		case "digipin": {
			const [lon, lat] = getLatLngFromDIGIPIN(query.code)

			return cellPlace(query.code, label, {
				lat,
				lon,
				latSpanDeg: DIGIPIN_CELL_DEGREES,
				lonSpanDeg: DIGIPIN_CELL_DEGREES,
			})
		}

		case "plus_code": {
			if (query.full) {
				const cell = decodePlusCode(query.code)

				if (!cell) throw new Error(`${query.code} is not a plus code this reader decodes.`)

				return cellPlace(query.code, label, cell)
			}

			if (!bias) {
				throw new Error(
					`${query.code} is a short plus code. It names a cell only near a reference place: zoom the map in to where it was printed, or type the full code.`
				)
			}

			const cell = recoverNearestPlusCode(query.code, bias.center[1], bias.center[0])

			if (!cell) throw new Error(`${query.code} is not a short plus code this reader recovers.`)

			return cellPlace(query.code, label, cell)
		}

		case "h3":
			return cellPlace(query.cell, label, await h3Cell(query.cell))

		case "geohash": {
			const { fromGeohash } = await import("@mailwoman/spatial/coordinate/formats")
			const cell = fromGeohash(query.hash)

			if (!cell) throw new Error(`${query.hash} is not a geohash.`)

			return cellPlace(query.hash, label, cell)
		}

		case "wof":
			return readWOFPlace(query.id)
	}
}

/**
 * The parse result for a point query: one component labeled with the shape's name and the located place.
 *
 * The tree is empty because no decoder ran, and the timing records only the lookup.
 */
export function pointQueryResult(
	input: string,
	query: PointReading,
	place: ResolvedPlaceView,
	lookupMs: number
): ParseResult {
	return {
		input,
		tree: { roots: [] },
		nodes: [
			{
				tag: POINT_QUERY_DESCRIPTIONS[query.recognized].label,
				value: input.trim(),
				confidence: 1,
				start: 0,
				end: input.length,
			},
		],
		kindResult: { kind: POINT_QUERY_KIND, confidence: 1, alternatives: [] },
		timing: { shape: 0, classify: 0, resolve: lookupMs },
		resolved: place,
		candidates: [place],
		fstActive: false,
		fstProvenance: null,
	}
}
