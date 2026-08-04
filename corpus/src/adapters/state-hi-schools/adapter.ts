/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `state-hi-schools`: Hawaii DOE public + charter schools CSV consumer.
 *
 *   The Hawaii State Department of Education publishes a directory of all HIDOE schools and public
 *   charter schools (PCS) as an XLSX workbook (`SchoolList.xlsx`) with two sheets: `HIDOE` (~258
 *   rows) and `PCS` (~38 rows). Total ~296 rows statewide. Each row carries a school name,
 *   single-line street address, city, ZIP, a numeric `code`, and HI-specific administrative columns
 *   (complex, complex_area, district, island, charter).
 *
 *   The adapter consumes a flat CSV the operator pre-builds via `fetch-state-hi-schools.ts`, which
 *   concatenates both sheets under one shared header. Column names match the workbook header
 *   verbatim (lower-snake-case: `code`, `name`, `address`, `city`, `zip`, ...).
 *
 *   Address parsing notes: Hawaii's residential numbering is hyphenated on Oahu (`47-470 Hui Aeko
 *   Place`), Kauai (`2-4035 Kaumualii Hwy`), and elsewhere. The shared HOUSE_NUMBER_PREFIX regex
 *   covers this via its optional `(?:-\d+)?` group.
 *
 *   The `island` and `district` columns are HIDOE administrative labels (Honolulu, Central, Leeward,
 *   Windward, Hilo, Hawaii, Maui, Kauai) — they are NOT US counties and intentionally are not
 *   surfaced as `subregion`.
 *
 *   Output: one row per school with `venue` (school name), `(house_number?, street, locality,
 *   region=HI, postcode)`, and a stable `source_id` derived from the school `code`.
 *
 *   License: stamped `"Public Domain"` per Hawaii state government open-data terms.
 */

import { CSVSpliterator } from "spliterator"

import { splitStreetLine, stableSourceID } from "../../adapter.ts"
import { lookupStateAbbreviation } from "../../codex/us-fips-state.ts"
import { reconcileComponents } from "../../format.ts"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.ts"

/**
 * Registry id for this adapter. Stamped into every row it emits, so a corpus record can be traced back to the dataset
 * it came from.
 */
export const STATE_HI_SCHOOLS_ADAPTER_ID = "state-hi-schools"
/**
 * License carried by this source (Public Domain), attached to each row so downstream consumers inherit the terms rather
 * than having to look them up.
 */
export const STATE_HI_SCHOOLS_DEFAULT_LICENSE = "Public Domain"

const HI_STATE_ABBR = "HI"

interface HiSchoolRow {
	code: string
	name: string
	address: string
	city: string
	zip: string
}

function normalizeZip(raw: string): string {
	const trimmed = raw.trim()

	if (!trimmed) return ""

	// XLSX → CSV conversion may emit numeric ZIPs without leading zeros. HI ZIPs all begin
	// with 96, so a 4-digit value indicates a leading-zero stripped during numeric coercion
	// (defensive — has not been observed in the published file as of 2026-05).
	if (/^\d{4}$/.test(trimmed)) return `0${trimmed}`

	return trimmed
}

export function createStateHiSchoolsAdapter(): CorpusAdapter {
	return {
		id: STATE_HI_SCHOOLS_ADAPTER_ID,
		defaultLicense: STATE_HI_SCHOOLS_DEFAULT_LICENSE,
		description: "Hawaii DOE School Directory — ~300 K-12 public + charter schools with venue+address (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`state-hi-schools adapter: only US supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				mode: "object",
				normalizeKeys: false,
				enableQuoteHandling: true,
			})

			const state = lookupStateAbbreviation(HI_STATE_ABBR)

			if (!state) {
				throw new Error(`state-hi-schools adapter: HI not found in state codex (corpus bug)`)
			}

			let emitted = 0

			for await (const record of rows as AsyncIterable<HiSchoolRow>) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const name = (record.name ?? "").trim()
				const address = (record.address ?? "").trim()
				const city = (record.city ?? "").trim()
				const zip = normalizeZip(record.zip ?? "")

				if (!name || !address || !city || !zip) continue

				const split = splitStreetLine(address)

				if (!split) continue

				const components: CanonicalRow["components"] = {
					venue: name,
					...(split.house_number ? { house_number: split.house_number } : {}),
					street: split.street,
					locality: city,
					region: state.abbreviation,
					postcode: zip,
				}

				const streetPart = [split.house_number, split.street].filter(Boolean).join(" ").trim()

				const raw = [
					name,
					streetPart,
					[city, [HI_STATE_ABBR, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
				]
					.filter(Boolean)
					.join(", ")

				const aligned = reconcileComponents(components, raw)

				if (Object.keys(aligned).length <= 2) continue

				const code = (record.code ?? "").toString().trim()

				const sourceID = code
					? `${STATE_HI_SCHOOLS_ADAPTER_ID}-${code}`
					: stableSourceID(STATE_HI_SCHOOLS_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: STATE_HI_SCHOOLS_ADAPTER_ID,
					source_id: sourceID,
					corpus_version: "",
					license: STATE_HI_SCHOOLS_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const stateHiSchoolsAdapter = createStateHiSchoolsAdapter()
