/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `state-hi-schools`: Hawaii DOE public + charter school workbook consumer.
 *
 *   The Hawaii State Department of Education publishes a directory of all HIDOE schools and public
 *   charter schools (PCS) as an XLSX workbook (`SchoolList.xlsx`) with two sheets: `HIDOE` (~258
 *   rows) and `PCS` (~38 rows). Total ~296 rows statewide. Each row carries a school name,
 *   single-line street address, city, ZIP, a numeric `code`, and HI-specific administrative columns
 *   (complex, complex_area, district, island, charter).
 *
 *   The adapter consumes the original XLSX retained by the fetcher and reads both worksheets directly.
 *   Legacy flat CSV artifacts remain accepted so existing source caches do not need conversion.
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

import { isPresent } from "@mailwoman/core/objects"
import { reconcileComponents } from "@mailwoman/formatter"
import { CSVSpliterator, XLSXSpliterator } from "spliterator"

import { type HiSchoolRow, schoolCellText, STATE_HI_SCHOOL_SHEETS } from "#adapters/state-hi-schools/workbook"
import { splitStreetLine, stableSourceID } from "#adapters/utils"
import { lookupStateAbbreviation } from "#codex/us-fips-state"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "#types"

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

function normalizeZip(raw: HiSchoolRow["zip"]): string {
	const trimmed = schoolCellText(raw)

	if (!trimmed) return ""

	// XLSX → CSV conversion may emit numeric ZIPs without leading zeros. HI ZIPs all begin
	// with 96, so a 4-digit value indicates a leading-zero stripped during numeric coercion
	// (defensive — has not been observed in the published file as of 2026-05).
	if (/^\d{4}$/.test(trimmed)) return `0${trimmed}`

	return trimmed
}

async function* readSchoolRows(inputPath: string): AsyncGenerator<HiSchoolRow> {
	if (inputPath.toLowerCase().endsWith(".xlsx")) {
		for (const sheet of STATE_HI_SCHOOL_SHEETS) {
			yield* XLSXSpliterator.fromAsync<HiSchoolRow>(inputPath, {
				sheet,
				mode: "object",
				normalizeKeys: false,
			})
		}

		return
	}

	yield* CSVSpliterator.fromAsync<HiSchoolRow>(inputPath, {
		mode: "object",
		normalizeKeys: false,
		enableQuoteHandling: true,
	})
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

			const state = lookupStateAbbreviation(HI_STATE_ABBR)

			if (!state) {
				throw new Error(`state-hi-schools adapter: HI not found in state codex (corpus bug)`)
			}

			let emitted = 0

			for await (const record of readSchoolRows(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const name = schoolCellText(record.name)
				const address = schoolCellText(record.address)
				const city = schoolCellText(record.city)
				const zip = normalizeZip(record.zip)

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

				const streetPart = [split.house_number, split.street].filter(isPresent).join(" ").trim()

				const raw = [
					name,
					streetPart,
					[city, [HI_STATE_ABBR, zip].filter(isPresent).join(" ")].filter(isPresent).join(", "),
				]
					.filter(isPresent)
					.join(", ")

				const aligned = reconcileComponents(components, raw)

				if (Object.keys(aligned).length <= 2) continue

				const code = schoolCellText(record.code)

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
