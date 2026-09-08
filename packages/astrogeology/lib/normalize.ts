/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Source row → feature, once, at build. The USGS products use east longitude in 0..360 with bounding boxes that may
 *   run past 360 (a feature on the prime meridian reads 359.2..360.16); rendering wants −180..180. Every conversion is
 *   here so a consumer never guesses the source convention.
 */

import type { BuildableBodyID } from "#bodies"
import { type PlanetaryNomenclatureFeature, PlanetaryNomenclatureFeatureSchema } from "#schema/nomenclature"

/**
 * One shapefile row as the GeoJSON transport carries it. An absent text attribute arrives as `""` from some rows and as
 * `null` from others (the Mars archive writes `null` for a missing `quad_name`); both mean absence.
 */
export interface NomenclatureSourceRow {
	name: string
	clean_name: string | null
	approvaldt: string | null
	origin: string | null
	diameter: number | null
	center_lon: number
	center_lat: number
	type: string
	code: string | null
	approval: string | null
	min_lon: number
	max_lon: number
	min_lat: number
	max_lat: number
	quad_name: string | null
	link: string
}

/**
 * A text attribute with `null` folded into the blank the schema maps to absence.
 */
const text = (value: string | null): string => value ?? ""

export interface NormalizedBBox {
	minLon: number
	maxLon: number
	minLat: number
	maxLat: number
	/**
	 * True when the box's west edge is east of its east edge after normalization: the box runs across ±180 and a renderer
	 * must split it, never draw it as a near-global rectangle.
	 */
	crossesAntimeridian: boolean
}

/**
 * A full turn in degrees: the width of the source's 0..360 range, and the shift that carries a longitude past 180 back
 * into −180..180.
 */
const FULL_TURN_DEGREES = 360

/**
 * Half a turn in degrees: the east edge of the −180..180 range every artifact carries.
 */
const HALF_TURN_DEGREES = 180

export function normalizeLongitude(lon: number): number {
	if (!Number.isFinite(lon) || lon < -HALF_TURN_DEGREES || lon > FULL_TURN_DEGREES) {
		throw new RangeError(`longitude ${lon} is outside 0..360 and -180..180`)
	}

	const shifted = lon > HALF_TURN_DEGREES ? lon - FULL_TURN_DEGREES : lon

	return Object.is(shifted, -0) ? 0 : shifted
}

const clampLat = (lat: number): number => Math.max(-90, Math.min(90, lat))

export function normalizeBBox(box: { minLon: number; maxLon: number; minLat: number; maxLat: number }): NormalizedBBox {
	// A box that runs past 360 wraps to the prime meridian; a box that runs past 180 wraps to the antimeridian. Both
	// arrive as minLon < maxLon in source units; only the second one crosses ±180 after normalization.
	const minLon = normalizeLongitude(box.minLon > FULL_TURN_DEGREES ? box.minLon - FULL_TURN_DEGREES : box.minLon)
	const maxLon = normalizeLongitude(box.maxLon > FULL_TURN_DEGREES ? box.maxLon - FULL_TURN_DEGREES : box.maxLon)

	return {
		minLon,
		maxLon,
		minLat: clampLat(box.minLat),
		maxLat: clampLat(box.maxLat),
		crossesAntimeridian: minLon > maxLon,
	}
}

export function featureIDFromLink(link: string): string {
	const match = /\/Feature\/(\d+)\s*$/u.exec(link)

	if (!match?.[1]) throw new Error(`nomenclature link carries no feature id: ${JSON.stringify(link)}`)

	return match[1]
}

export function approvalDateFromSource(value: string): string | undefined {
	const match = /^(\d{4})\/(\d{2})\/(\d{2})/u.exec(value)

	return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined
}

export function featureFromSourceRow(body: BuildableBodyID, row: NomenclatureSourceRow): PlanetaryNomenclatureFeature {
	return PlanetaryNomenclatureFeatureSchema.parse({
		id: featureIDFromLink(row.link),
		body,
		name: row.name,
		cleanName: text(row.clean_name),
		featureType: row.type,
		featureTypeCode: text(row.code),
		diameterKm: row.diameter ?? undefined,
		centerLon: normalizeLongitude(row.center_lon),
		centerLat: clampLat(row.center_lat),
		bbox: normalizeBBox({ minLon: row.min_lon, maxLon: row.max_lon, minLat: row.min_lat, maxLat: row.max_lat }),
		approvalStatus: text(row.approval),
		approvalDate: approvalDateFromSource(text(row.approvaldt)),
		origin: text(row.origin),
		quadName: text(row.quad_name),
		source: "usgs-iau",
	})
}
