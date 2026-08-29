/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Anchor-adjudicated point choice for the WOF admin ingest (#1905).
 *
 *   The ingest prefers `lbl:` over `geom:` because the math centroid is wrong exactly where it
 *   matters (France's `geom:` point is in Spain). But the label point carries its own upstream
 *   defects: WOF's `lbl:` for `Washington` (wof:85931779) sits at 38.82652, −77.01712 — the
 *   district's southern tip, 7.8 km from the city — and the shipped preference imported it
 *   faithfully, which is what put four metamorphic BAND rows 8.1 km out.
 *
 *   Neither point can arbitrate itself, so where the two DISAGREE the record's own GeoNames
 *   concordance is the independent anchor. Census over the 2026-08-25 artifact's repo-backed
 *   localities above 100,000 population (1,612 records carrying both points): 144 disagree by more
 *   than {@link LABEL_GEOM_DISAGREEMENT_KM}; adjudicated against their `gn:id` anchor, 48 have the
 *   label point closer (the Chinese prefecture-city shape — the label marks the urban seat, the
 *   centroid the vast polygon), 40 have the GEOMETRIC point at least
 *   {@link ANCHOR_DECISIVE_RATIO}× closer (Washington, Frankfurt am Main at 10.8 km, Stuttgart at
 *   9.5 km, Oklahoma City at 11.3 km, Chennai at 12.5 km, Yokohama at 14.5 km), 52 separate by less
 *   than the ratio and 4 carry no anchor.
 *
 *   The rule is therefore conservative by construction: the anchor overrides the label preference
 *   ONLY when the two points disagree beyond the threshold AND the anchor separates them at the
 *   decisive ratio. Agreeing points, anchorless records, and unclear separations all keep the
 *   existing label-first behavior byte-identically.
 */

import { existsSync, readFileSync } from "@mailwoman/platform/fs"
import { join } from "@mailwoman/platform/path"
import { haversineKm } from "@mailwoman/spatial"
import { TSVSpliterator } from "spliterator"

/**
 * A candidate or anchor coordinate pair, WGS-84 decimal degrees.
 */
export interface PointPair {
	latitude: number
	longitude: number
}

/**
 * Below this label-versus-geometric disagreement the anchor is never consulted — the pair agrees to within ordinary
 * centroid noise and the label preference stands.
 */
export const LABEL_GEOM_DISAGREEMENT_KM = 5

/**
 * The anchor must be this many times closer to one point than the other to override the default. At less separation the
 * anchor cannot say which point is the settlement, and the label keeps winning.
 */
export const ANCHOR_DECISIVE_RATIO = 2

export type PointChoice = "lbl" | "geom" | "geom-by-anchor" | "lbl-by-anchor"

export interface AdjudicatedPoint extends PointPair {
	choice: PointChoice
}

/**
 * Resolve a `gn:id` concordance to its GeoNames coordinate, scoped by country. `undefined` is ABSENCE — no anchor for
 * this record — and the caller must fall back to the label preference rather than treating it as a zero-distance
 * anchor.
 */
export type GeoNamesAnchorLookup = (country: string, gnID: string | number) => PointPair | undefined

/**
 * Choose the stored point for a record carrying both a label and a geometric centroid.
 *
 * With no disagreement, no anchor, or an anchor that does not separate the pair decisively, the label point wins — the
 * existing preference, unchanged. The anchor speaks only in the narrow band the module docstring's census measured.
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
 * GeoNames tab-separated column offsets (the standard country-file dump layout): id first, then name fields; latitude
 * and longitude sit at columns 4 and 5.
 */
const GN_COLUMN_ID = 0
const GN_COLUMN_LAT = 4
const GN_COLUMN_LON = 5

/**
 * Build a lazy per-country anchor lookup over a GeoNames country-file directory (`<dir>/<CC>.txt`).
 *
 * A country file loads on the FIRST anchor request for that country and is cached as an id → point map; a country whose
 * file is absent caches an empty map, so a data root without GeoNames extracts degrades to "no anchor anywhere" — the
 * label preference, byte-identical to a build without this module. Loading is synchronous by design: the consult
 * happens inside the ingest's per-feature parse, and it fires only for the rare wide-disagreement records, so the cost
 * is one file read per country that HAS such a record.
 */
export function createGeoNamesAnchorLookup(geonamesDir: string): GeoNamesAnchorLookup {
	const byCountry = new Map<string, Map<string, PointPair>>()

	const load = (country: string): Map<string, PointPair> => {
		const cached = byCountry.get(country)

		if (cached) return cached

		const points = new Map<string, PointPair>()
		const path = join(geonamesDir, `${country.toUpperCase()}.txt`)

		// Missing country extract → empty map, cached: absence of anchors, never an error. `from` parses CONTENT
		// (a path argument would be parsed as one row of itself), so the file is read once and streamed through the
		// TSV parser — the sync shape this in-parse consult needs.
		if (existsSync(path)) {
			for (const cols of TSVSpliterator.from(readFileSync(path, "utf8"), { header: false })) {
				const latitude = Number(cols[GN_COLUMN_LAT])
				const longitude = Number(cols[GN_COLUMN_LON])

				if (cols[GN_COLUMN_ID] && Number.isFinite(latitude) && Number.isFinite(longitude)) {
					points.set(String(cols[GN_COLUMN_ID]), { latitude, longitude })
				}
			}
		}

		byCountry.set(country, points)

		return points
	}

	return (country, gnID) => {
		if (!country) return undefined

		return load(country).get(String(gnID))
	}
}
