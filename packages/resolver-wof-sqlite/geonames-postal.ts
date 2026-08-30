/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #920 — fold GeoNames POSTAL codes into a WOF/unified postcode shard as first-class
 *   `postalcode` places, for the countries whose WOF postalcode repos don't exist (the
 *   namesake-tail locales: FI/CZ/SK/SI/DK/NO/HR/PL and any future gap).
 *
 *   Why: the night-31 taxonomy measured the cross-locale resolve tail as NAMESAKE COLLISION
 *   (FI 300/1k … PL 75/1k offender rows), and the controlled experiment showed postcode-shard
 *   coverage alone collapses it (FI 300→1, CZ 131→4): a resolvable postcode node feeds the
 *   resolver's coordinate-first sibling-postcode candidate injection, which binds the locality
 *   pick to its postcode neighborhood. The implementation already ships; it was coverage-starved.
 *
 *   Two hard-won laws from the experiment are enforced HERE, in code, not in a runbook:
 *
 *   1. **The name law (#920 format law):** a postcode row's `name` is stored in the
 *      SANITIZED-QUERY token shape — every non-letter/number stripped — because that is what
 *      `sanitizeFTSQuery` reduces the parsed token to at lookup time. Stored `"110 00"` (CZ) or
 *      `"11-041"` (PL) can never match the query `"11000"`/`"11041"`; the spaced CZ build
 *      measured WORSE than no coverage (+13 namesake rows) because its bigrams partial-matched
 *      WRONG codes. The display form is preserved as an alt row in `names`.
 *   2. **Medoid centroids:** GeoNames postal is one row per (postcode, settlement); the naive
 *      mean-of-members centroid displaced tighter village coordinates on already-correct rows
 *      (the p50-tax that ni-failed SK/SI/HR at 1.10–1.94 km CI). The MEDOID — the member point
 *      nearest the mean — keeps the coordinate on a real settlement.
 *
 *   Package home for the same reason as `geonames-aliases.ts`: `build-unified-wof
 *   --geonames-postal-countries`, any standalone fold, and the `mailwoman gazetteer` commands
 *   share ONE implementation. GeoNames postal dump = `download.geonames.org/export/zip/<CC>.zip`
 *   → `<CC>.txt` (TSV: country, postcode, place, admin1, code1, admin2, code2, admin3, code3,
 *   lat, lon, accuracy). License CC BY 4.0 — attribution rides the shard's `meta` provenance and
 *   the model card like the existing GeoNames alias fold.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"
import { TSVSpliterator } from "spliterator"

import type { WOFDatabase } from "./schema.ts"

/**
 * Column count of a GeoNames postal-code TSV row. Short rows are truncated or blank and are skipped. See the
 * allCountries.zip readme for the field list.
 */
const GEONAMES_POSTAL_COLUMNS = 11

/**
 * Synthetic id base for GeoNames-POSTAL rows — its own namespace above the alias fold's {@link GEONAMES_ID_BASE} (9e12)
 * allocation so all four sources (WOF, Overture, GeoNames-alias, GeoNames-postal) coexist collision-free in a combined
 * DB.
 */
export const GEONAMES_POSTAL_ID_BASE = 9_500_000_000_000

/**
 * The #920 name law: reduce a postcode to the sanitized-query token shape — strip every non-letter/number — so the
 * stored name matches what `sanitizeFTSQuery` produces from the parsed postcode token. `"110 00"` → `"11000"`,
 * `"11-041"` → `"11041"`, `"AD500"` → `"AD500"`.
 */
export function normalizePostcodeName(raw: string): string {
	return raw.replaceAll(/[^\p{L}\p{N}]/gu, "")
}

/**
 * A `[latitude, longitude]` member point of a postcode group.
 */
export type PostcodePoint = readonly [number, number]

/**
 * The #920 MEDOID law: pick the member point nearest the group's mean, never the mean itself.
 *
 * A postcode whose evidence is several scattered points has no single "true" centre, and the tempting answer — average
 * them — puts the code somewhere no address is. The night-31 experiment measured that as a p50 tax severe enough to
 * fail SK/SI/HR at 1.10–1.94 km CI: the mean displaced coordinates that were already correct. The medoid stays on a
 * real observation, so a single-member group is exactly its own point and a multi-member group is one of its members.
 *
 * Distance is squared-Euclidean in DEGREES, not haversine. At the scale a postcode spans, the ranking the two produce
 * is the same, and this one carries no trig into a per-group inner loop. Ties go to the earliest member, which makes
 * the result a pure function of the input order — the property a rebuilt shard's ids depend on.
 *
 * Exported (rather than inlined at each ingest) because it is the second half of the #920 pair: every postcode source
 * that groups member points — GeoNames postal, OSM `addr:postcode` — owes the same law, and a second hand-rolled copy
 * is where they drift.
 */
export function medoidPoint(points: readonly PostcodePoint[]): PostcodePoint {
	const first = points[0]

	if (!first) throw new Error("medoidPoint: no member points")

	if (points.length === 1) return first

	let sumLat = 0
	let sumLon = 0

	for (const p of points) {
		sumLat += p[0]
		sumLon += p[1]
	}

	const meanLat = sumLat / points.length
	const meanLon = sumLon / points.length

	let best = first
	let bestD = Infinity

	for (const p of points) {
		const d = (p[0] - meanLat) ** 2 + (p[1] - meanLon) ** 2

		if (d < bestD) {
			bestD = d
			best = p
		}
	}

	return best
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
	 * Countries whose `<CC>.txt` was missing under the postal dir (skipped, reported).
	 */
	missing: string[]
}

/**
 * Fold GeoNames postcodes for `countries` into an open unified/postcode ingest DB: one `spr` row per distinct
 * normalized postcode (placetype `postalcode`, medoid centroid, degenerate bbox), the normalized form as `name`, and
 * the display form as an extra `names` row when it differs. The caller owns the FTS rebuild (rows ride the standard
 * freeze phase).
 */
export async function ingestGeonamesPostal(
	db: DatabaseClient<WOFDatabase>,
	countries: readonly string[],
	postalDir: string
): Promise<GeonamesPostalIngestResult> {
	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, -1, ?, 'postalcode', ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)`
	)

	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'postalcode', ?, '', 0)`
	)

	let nextID = GEONAMES_POSTAL_ID_BASE
	const byCountry: Record<string, number> = {}
	const missing: string[] = []
	let inserted = 0

	for (const country of countries) {
		const cc = country.toUpperCase()
		const file = join(postalDir, `${cc}.txt`)

		if (!(await pathExists(file))) {
			missing.push(cc)

			console.error(
				`  GeoNames postal ${cc}: ${file} missing — download from download.geonames.org/export/zip/${cc}.zip; skipped`
			)

			continue
		}

		// Group member settlement points per NORMALIZED code; remember one display form.
		const members = new Map<string, { display: string; pts: Array<[number, number]> }>()

		// Streamed: a national dump is a caller-supplied size — GB's is 177 MB, and only the caller
		// knows which country is next. `header: false` is required; the GeoNames postal dump is
		// headerless, so row 1 would be consumed as column names and its postcode lost.
		for await (const cols of TSVSpliterator.fromAsync(file, { header: false })) {
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

		for (const [name, m] of members) {
			// Medoid: the member point nearest the mean — stays on a real settlement (the p50-tax law).
			const best = medoidPoint(m.pts)
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

		console.error(`  GeoNames postal ${cc}: ${members.size.toLocaleString()} distinct codes (medoid centroids)`)
	}

	return { inserted, byCountry, missing }
}
