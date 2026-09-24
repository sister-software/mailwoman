/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Choose between WOF label and geometric points using a GeoNames anchor.
 *   Override the label preference only when points disagree beyond the registered distance
 *   and the anchor is decisively closer to one. Otherwise retain the label point.
 */

import { readUnquotedTSVText } from "@mailwoman/core/fs/delimited"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { haversineKm } from "@mailwoman/spatial"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"

/**
 * A candidate or anchor coordinate pair, WGS-84 decimal degrees.
 */
export interface PointPair {
	latitude: number
	longitude: number
}

/**
 * Minimum label/geometric separation before consulting the anchor, in kilometers.
 */
export const LABEL_GEOM_DISAGREEMENT_KM = 5

/**
 * Required anchor-distance ratio to override the label preference.
 */
export const ANCHOR_DECISIVE_RATIO = 2

export type PointChoice = "lbl" | "geom" | "geom-by-anchor" | "lbl-by-anchor"

export interface AdjudicatedPoint extends PointPair {
	choice: PointChoice
}

/**
 * Resolve a `gn:id` concordance to its GeoNames coordinate, scoped by country.
 *
 * `undefined` is absence — no anchor for this record — and the caller must fall back
 * to the label preference rather than treating it as a zero-distance anchor.
 */
export type GeoNamesAnchorLookup = (country: string, gnID: string | number) => Promise<PointPair | undefined>

/**
 * Choose the stored point; ambiguous or unanchored cases retain the label point.
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
 * GeoNames country-file columns for id, latitude, and longitude.
 */
const GN_COLUMN_ID = 0
const GN_COLUMN_LAT = 4
const GN_COLUMN_LON = 5

/**
 * Build a lazy, cached lookup from GeoNames country files.
 *
 * Missing files produce empty maps; files load on the first country lookup.
 */
export async function createGeoNamesAnchorLookup(geonamesDir: PathBuilderLike): Promise<GeoNamesAnchorLookup> {
	const byCountry = new Map<string, Promise<Map<string, PointPair>>>()

	const load = (country: string): Promise<Map<string, PointPair>> => {
		const cached = byCountry.get(country)

		if (cached) return cached

		const pending = (async (): Promise<Map<string, PointPair>> => {
			const points = new Map<string, PointPair>()
			const path = resolvePathBuilder(geonamesDir, `${country.toUpperCase()}.txt`)

			// Cache missing extracts as empty maps; parse file contents, not the path string.
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
