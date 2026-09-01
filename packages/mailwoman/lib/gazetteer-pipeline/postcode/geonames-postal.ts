/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The GeoNames postal-dump row reader the CJK postcode-locality builders share.
 */

import { pyFloat } from "@mailwoman/core/numeric"
import { TSVSpliterator } from "spliterator"

/**
 * One usable row of a GeoNames postal dump: a postcode with a parseable coordinate, plus the settlement and admin-1
 * names beside it.
 */
export interface GeonamesPostalRow {
	postcode: string
	placeName: string
	admin1: string
	latitude: number
	longitude: number
}

/**
 * Iterate a GeoNames postal dump (`download.geonames.org/export/zip/<CC>.zip` → `<CC>.txt`, TSV): one row per
 * (postcode, settlement) that carries a parseable coordinate. `header: false` is required — the dump is headerless, so
 * row 1 would otherwise be read as column names.
 *
 * Callers own the REDUCTION: the JP builder keeps the LAST row per postcode, the KR builder the FIRST, and both
 * semantics are theirs rather than this reader's. (`zcta-centroids.ts`'s `parseGeonamesCentroids` is the third reader
 * of this format and deliberately stays local: it is synchronous over an in-memory string by test contract, and its
 * `Number` + `(0, 0)`-skip validity rules differ from the `pyFloat` port here.)
 */
export async function* geonamesPostalRows(source: string): AsyncGenerator<GeonamesPostalRow> {
	for await (const f of TSVSpliterator.fromAsync(source, { header: false })) {
		if (f.length > 10 && f[1]) {
			const latitude = pyFloat(f[9])
			const longitude = pyFloat(f[10])

			if (latitude === null || longitude === null) continue

			yield { postcode: f[1], placeName: f[2] ?? "", admin1: f[3] ?? "", latitude, longitude }
		}
	}
}
