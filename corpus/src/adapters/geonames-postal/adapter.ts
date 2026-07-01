/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `geonames-postal`: GeoNames postal-code dump consumer (https://www.geonames.org/, CC-BY-4.0).
 *
 *   The GeoNames postal export (`https://download.geonames.org/export/zip/<CC>.zip`) is a clean,
 *   per-country `postcode → place → admin1` table with the place + region NAMES inline (no aux-file
 *   join needed). It broadens the corpus's postcode→locality→region coverage to ~80 countries, well
 *   beyond `wof-postalcode`/the coordinate-first table — forward coverage for the multi-locale
 *   goal.
 *
 *   Input: a per-country postal dump (`<CC>.txt`, 12 tab-separated columns, no header): country,
 *   postcode, place, admin1_name, admin1_code, admin2__, admin3__, lat, lon, accuracy.
 *
 *   Output: per row, postcode-FIRST (international) variants — the common order for the non-US
 *   locales this fills (US postcodes are already covered by TIGER/WOF, which use postcode-LAST):
 *
 *   1. `{ postcode, locality }` → "AD100 Canillo"
 *   2. `{ postcode, locality, region }` → "AD100 Canillo, Canillo" Prefer configuring this adapter for
 *        non-US countries; for US, the postcode-last sources are the right order. License:
 *        `"CC-BY-4.0"` per row (attribute "GeoNames").
 */

import { createReadStream } from "node:fs"

import { parse as csvParse } from "csv-parse"

import { stableSourceID } from "../../adapter.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const GEONAMES_POSTAL_ADAPTER_ID = "geonames-postal"
export const GEONAMES_POSTAL_DEFAULT_LICENSE = "CC-BY-4.0"

// GeoNames postal-dump columns (0-based).
const COL = { country: 0, postcode: 1, place: 2, admin1Name: 3 } as const

export function createGeonamesPostalAdapter(): CorpusAdapter {
	return {
		id: GEONAMES_POSTAL_ADAPTER_ID,
		defaultLicense: GEONAMES_POSTAL_DEFAULT_LICENSE,
		description:
			"GeoNames postal codes (CC-BY-4.0) — multi-locale postcode→locality→region, names inline; international postcode-first order.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const stream = createReadStream(opts.inputPath, { encoding: "utf8" })
			const parser = stream.pipe(
				csvParse({ delimiter: "\t", quote: false, relax_column_count: true, skip_empty_lines: true })
			)

			let emitted = 0

			try {
				for await (const rec of parser as AsyncIterable<string[]>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const cc = (rec[COL.country] ?? "").trim()

					if (!cc) continue

					if (opts.country && cc !== opts.country) continue

					const postcode = (rec[COL.postcode] ?? "").trim()
					const locality = (rec[COL.place] ?? "").trim()

					if (!postcode || !locality) continue
					const region = (rec[COL.admin1Name] ?? "").trim()

					// Postcode-first (international) variants. Skip the region variant when admin1 just
					// repeats the place (common for city-states / micro-admin) to avoid "X X" noise.
					const variants: Array<{ slot: string; comp: CanonicalRow["components"]; raw: string }> = [
						{ slot: "pl", comp: { postcode, locality }, raw: `${postcode} ${locality}` },
					]

					if (region && region.toLowerCase() !== locality.toLowerCase()) {
						variants.push({
							slot: "plr",
							comp: { postcode, locality, region },
							raw: `${postcode} ${locality}, ${region}`,
						})
					}

					for (const v of variants) {
						if (opts.limit !== undefined && emitted >= opts.limit) break
						const aligned = reconcileComponents(v.comp, v.raw)

						if (Object.keys(aligned).length < 2) continue
						yield {
							raw: v.raw,
							components: aligned,
							country: cc,
							source: GEONAMES_POSTAL_ADAPTER_ID,
							source_id: `${stableSourceID(GEONAMES_POSTAL_ADAPTER_ID, aligned)}-${v.slot}`,
							corpus_version: "",
							license: GEONAMES_POSTAL_DEFAULT_LICENSE,
						}
						emitted++
					}
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const geonamesPostalAdapter = createGeonamesPostalAdapter()
