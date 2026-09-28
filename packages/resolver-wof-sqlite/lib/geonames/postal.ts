/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fold GeoNames postcode rows into a WOF or unified postcode extract as first-class `postalcode`
 *   places, for countries whose WOF postalcode repos do not exist.
 *
 *   Two laws are enforced here in code rather than in a runbook.
 *
 *   1. The name law. A postcode row's `name` is stored in the sanitized-query token shape with
 *      every non-letter and non-number stripped, because that is what `sanitizeFTSQuery` reduces
 *      the parsed token to at lookup time. A stored `"110 00"` or `"11-041"` can never match the
 *      query `"11000"` or `"11041"`. The display form is preserved as an alt row in `names`.
 *   2. The medoid law. A postcode whose rows carry scattered points has no single true centre, and
 *      averaging them puts the code somewhere no address is. The medoid is the member point
 *      nearest the group's mean.
 *
 *   `build-unified-wof --geonames-postal-countries`, any standalone fold, and the `mailwoman
 *   gazetteer` commands share one implementation. The GeoNames postal dump is
 *   `download.geonames.org/export/zip/<CC>.zip` → `<CC>.txt`, a headerless TSV of country,
 *   postcode, place, admin1, code1, admin2, code2, admin3, code3, lat, lon, accuracy. License
 *   CC BY 4.0, so attribution rides the extract's `meta` provenance and the model card.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers"
import { GEONAMES_POSTAL_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"

import type { WOFDatabase } from "#schema"

/**
 * Column count of a GeoNames postal-code TSV row.
 *
 * Short rows are truncated or blank and are skipped.
 * See the allCountries.zip readme for the field list.
 */
const GEONAMES_POSTAL_COLUMNS = 11

/**
 * Reduce a postcode to the sanitized-query token shape, stripping every non-letter and non-number,
 * so the stored name matches what `sanitizeFTSQuery` produces from the parsed postcode token.
 *
 * `"110 00"` → `"11000"`, `"11-041"` → `"11041"`, `"AD500"` → `"AD500"`.
 */
export function normalizePostcodeName(raw: string): string {
	return raw.replaceAll(/[^\p{L}\p{N}]/gu, "")
}

/**
 * A `[latitude, longitude]` member point of a postcode group.
 */
export type PostcodePoint = readonly [number, number]

/**
 * A medoid and the size of the group it came from.
 *
 * These two integers describe the source dump.
 * `@mailwoman/evidence`'s `EpistemicStatus` vocabulary belongs to the answering path,
 * where `epistemicStatusFor` derives it, and naming them `observed` or `derived`
 * here would give those words a second, local meaning.
 */
export interface MedoidSupport {
	/**
	 * The medoid over the distinct member points.
	 */
	point: PostcodePoint
	/**
	 * Rows the group held.
	 */
	rows: number
	/**
	 * Distinct coordinates among them.
	 *
	 * One means every row named the same point.
	 * In a dump whose coordinates are computed, that is one value inherited N times
	 * rather than N sources agreeing.
	 */
	distinctPoints: number
}

/**
 * Collapse a group to its distinct points before any geometric consensus reads it.
 *
 * Rows sharing a coordinate to the digit are not independent measurements.
 * GeoNames computes a postal coordinate by matching the code against the names of places
 * and admin divisions, and averages neighbouring codes where the match fails,
 * so one computed value reaches every row that matched it.
 *
 * Exact equality rather than a proximity radius.
 * `collapseCoincident` answers a different question, which ranked candidates are the same physical
 * place within `COINCIDENT_PLACE_KM`, and two surveyed settlements 200 m apart are two points here.
 */
function collapseDuplicatePoints(points: readonly PostcodePoint[]): PostcodePoint[] {
	const seen = new Set<string>()
	const out: PostcodePoint[] = []

	for (const p of points) {
		const key = `${p[0]},${p[1]}`

		if (seen.has(key)) continue

		seen.add(key)
		out.push(p)
	}

	return out
}

/**
 * Pick the member point nearest the group's mean, never the mean itself.
 *
 * The medoid stays on a real observation, so a single-member group is exactly its own point
 * and a multi-member group is one of its members.
 * The bound applies only while the members are distinct, so duplicate points are collapsed first.
 *
 * Counting N rows at one coordinate separately would weight that value by how many settlements
 * inherited it. {@link MedoidSupport.distinctPoints} reports how many points the answer rested on.
 *
 * Distance is squared-Euclidean in degrees rather than haversine.
 * At the scale a postcode spans the two produce the same ranking, and this one
 * keeps trig out of a per-group inner loop.
 *
 * Ties go to the earliest member, which makes the result a pure function of the
 * input order, the property a rebuilt extract's ids depend on.
 *
 * Exported rather than inlined at each ingest because every postcode source that
 * groups member points, GeoNames postal and OSM `addr:postcode`, owes the same law,
 * and a second hand-rolled copy is where they drift.
 */
export function medoidPoint(points: readonly PostcodePoint[]): PostcodePoint {
	return medoidWithSupport(points).point
}

/**
 * {@link medoidPoint} with the group size it rested on, for a caller that must
 * record how thin the answer was.
 */
export function medoidWithSupport(points: readonly PostcodePoint[]): MedoidSupport {
	if (!points.length) throw new Error("medoidWithSupport: no member points")

	const distinct = collapseDuplicatePoints(points)
	const only = distinct[0]!

	if (distinct.length === 1) {
		return { point: only, rows: points.length, distinctPoints: 1 }
	}

	let sumLat = 0
	let sumLon = 0

	for (const p of distinct) {
		sumLat += p[0]
		sumLon += p[1]
	}

	const meanLat = sumLat / distinct.length
	const meanLon = sumLon / distinct.length

	let best = only
	let bestD = Infinity

	for (const p of distinct) {
		const d = (p[0] - meanLat) ** 2 + (p[1] - meanLon) ** 2

		if (d < bestD) {
			bestD = d
			best = p
		}
	}

	return { point: best, rows: points.length, distinctPoints: distinct.length }
}

export interface GeonamesPostalIngestResult {
	/**
	 * Distinct postcodes inserted across all countries.
	 */
	inserted: number
	/**
	 * Per-country distinct-postcode counts.
	 */
	byCountry: Record<string, number>
	/**
	 * Per-country count of inserted codes the dump carried on several rows that all named one point.
	 *
	 * The coordinate rests on a single value no matter how many settlements sit under the code.
	 * Reported rather than refused: the point is still the best the source offers,
	 * and a consumer weighing postal coverage needs to know how much of it is this.
	 */
	singlePointByCountry: Record<string, number>
	/**
	 * Countries whose `<CC>.txt` was missing under the postal dir (skipped, reported).
	 */
	missing: string[]
}

/**
 * Fold GeoNames postcodes for `countries` into an open unified/postcode ingest DB: one `spr` row
 * per distinct normalized postcode (placetype `postalcode`, medoid centroid, degenerate bbox),
 * the normalized form as `name`, and the display form as an extra `names` row when it differs.
 *
 * The caller owns the FTS rebuild (rows ride the standard freeze phase).
 */
export async function ingestGeonamesPostal(
	db: DatabaseClient<WOFDatabase>,
	countries: readonly string[],
	postalDir: PathBuilderLike
): Promise<GeonamesPostalIngestResult> {
	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, -1, ?, 'postalcode', ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)`
	)

	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'postalcode', ?, '', 0)`
	)

	let nextID = GEONAMES_POSTAL_ID_BASE
	const byCountry: Record<string, number> = {}
	const singlePointByCountry: Record<string, number> = {}
	const missing: string[] = []
	let inserted = 0

	for (const country of countries) {
		const cc = country.toUpperCase()
		const file = resolvePathBuilder(postalDir, `${cc}.txt`)

		if (!(await pathExists(file))) {
			missing.push(cc)

			console.error(
				`  GeoNames postal ${cc}: ${file} missing — download from download.geonames.org/export/zip/${cc}.zip; skipped`
			)

			continue
		}

		const members = new Map<string, { display: string; pts: Array<[number, number]> }>()

		// The dump is headerless, so row 1 would otherwise be consumed as column headings and its postcode lost.
		// `header: false` is required.
		for await (const cols of readUnquotedTSV(file)) {
			if (cols.length < GEONAMES_POSTAL_COLUMNS) continue
			const display = cols[1]!.trim()
			const name = normalizePostcodeName(display)
			const lat = Number(cols[9])
			const lon = Number(cols[10])

			if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
			const m = members.get(name) ?? { display, pts: [] }
			m.pts.push([lat, lon])
			members.set(name, m)
		}

		db.exec("BEGIN")

		let singlePoint = 0

		for (const [name, m] of members) {
			const support = medoidWithSupport(m.pts)
			const best = support.point

			if (support.distinctPoints === 1 && support.rows > 1) {
				singlePoint++
			}

			const id = nextID++
			sprInsert.run(id, name, cc, best[0], best[1], best[0], best[1], best[0], best[1])
			namesInsert.run(id, name, cc)

			if (m.display !== name) {
				namesInsert.run(id, m.display, cc)
			}

			inserted++
		}

		db.exec("COMMIT")
		byCountry[cc] = members.size
		singlePointByCountry[cc] = singlePoint

		console.error(
			`  GeoNames postal ${cc}: ${members.size.toLocaleString()} distinct codes (medoid centroids), ` +
				`${singlePoint.toLocaleString()} resting on one repeated point`
		)
	}

	return { inserted, byCountry, singlePointByCountry, missing }
}
