/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Chooses between a WOF record's label point and geometry point by comparing both with a GeoNames
 *   anchor.
 */

import { readUnquotedTSVText } from "@mailwoman/core/fs/delimited"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { haversineKm } from "@mailwoman/spatial"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"

/**
 * A coordinate in WGS-84 decimal degrees.
 */
export interface PointPair {
	latitude: number
	longitude: number
}

/**
 * The label-to-geometry distance in kilometers above which the anchor is consulted.
 */
export const LABEL_GEOM_DISAGREEMENT_KM = 5

/**
 * How many times closer to the anchor one point must be for the anchor to decide.
 */
export const ANCHOR_DECISIVE_RATIO = 2

/**
 * Which point the adjudicator stored, and whether the anchor decided it.
 */
export type PointChoice = "lbl" | "geom" | "geom-by-anchor" | "lbl-by-anchor"

/**
 * The chosen point and the reason for the choice.
 */
export interface AdjudicatedPoint extends PointPair {
	choice: PointChoice
}

/**
 * Looks up the GeoNames coordinate for a `gn:id` concordance within a country.
 *
 * It returns `undefined` when there is no anchor, and the caller then keeps the label point.
 */
export type GeoNamesAnchorLookup = (country: string, gnID: string | number) => Promise<PointPair | undefined>

/**
 * Chooses the point to store.
 *
 * The geometry point wins only when the two points are more than {@link LABEL_GEOM_DISAGREEMENT_KM}
 * apart and the geometry point is {@link ANCHOR_DECISIVE_RATIO} times closer to the anchor.
 * Every other case keeps the label point.
 */
export function choosePoint(geom: PointPair, lbl: PointPair, anchor: PointPair | undefined): AdjudicatedPoint {
	const disagreement = haversineKm(geom.latitude, geom.longitude, lbl.latitude, lbl.longitude)

	if (disagreement <= LABEL_GEOM_DISAGREEMENT_KM || !anchor) {
		return { ...lbl, choice: "lbl" }
	}

	const geomToAnchor = haversineKm(geom.latitude, geom.longitude, anchor.latitude, anchor.longitude)
	const lblToAnchor = haversineKm(lbl.latitude, lbl.longitude, anchor.latitude, anchor.longitude)

	if (geomToAnchor * ANCHOR_DECISIVE_RATIO < lblToAnchor) {
		return { ...geom, choice: "geom-by-anchor" }
	}

	if (lblToAnchor * ANCHOR_DECISIVE_RATIO < geomToAnchor) {
		return { ...lbl, choice: "lbl-by-anchor" }
	}

	return { ...lbl, choice: "lbl" }
}

/**
 * The GeoNames country-file columns for ID, latitude, and longitude.
 */
const GN_COLUMN_ID = 0
const GN_COLUMN_LAT = 4
const GN_COLUMN_LON = 5

/**
 * Builds a cached anchor lookup over GeoNames country files.
 *
 * Each country's file loads on its first lookup.
 * A missing file behaves as an empty file.
 */
export async function createGeoNamesAnchorLookup(geonamesDir: PathBuilderLike): Promise<GeoNamesAnchorLookup> {
	const byCountry = new Map<string, Promise<Map<string, PointPair>>>()

	const load = (country: string): Promise<Map<string, PointPair>> => {
		const cached = byCountry.get(country)

		if (cached) return cached

		const pending = (async (): Promise<Map<string, PointPair>> => {
			const points = new Map<string, PointPair>()
			const path = resolvePathBuilder(geonamesDir, `${country.toUpperCase()}.txt`)

			if (await pathExists(path)) {
				for (const cols of readUnquotedTSVText(await readLocalTextFile(path))) {
					const latitude = Number(cols[GN_COLUMN_LAT])
					const longitude = Number(cols[GN_COLUMN_LON])

					if (cols[GN_COLUMN_ID] && Number.isFinite(latitude) && Number.isFinite(longitude)) {
						points.set(String(cols[GN_COLUMN_ID]), { latitude, longitude })
					}
				}
			}

			return points
		})()

		byCountry.set(country, pending)

		return pending
	}

	return async (country, gnID) => {
		if (!country) return undefined

		return (await load(country)).get(String(gnID))
	}
}
