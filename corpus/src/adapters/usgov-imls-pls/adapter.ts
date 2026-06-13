/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-imls-pls`: IMLS Public Libraries Survey outlet CSV consumer.
 *
 *   The Institute of Museum and Library Services publishes an annual Public Libraries Survey with one
 *   row per library outlet (~17K rows). Each row carries the library name, street address, city,
 *   ZIP, county, and geocoordinates.
 *
 *   The adapter consumes the outlet CSV the operator pre-downloads via `fetch-imls-pls.sh`. Column
 *   names match the IMLS PLS outlet file header.
 *
 *   Output: one row per outlet with `venue` (library name), `(house_number, street, locality,
 *   subregion, postcode)`, and lat/lon preserved in `source_id` stability.
 *
 *   License: stamped `"Public Domain"` per IMLS federal government distribution terms.
 */

import { parse as csvParse } from "csv-parse"
import { createReadStream } from "node:fs"
import { stableSourceId } from "../../adapter.js"
import { lookupStateAbbreviation } from "../../codex/us-fips-state.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const USGOV_IMLS_PLS_ADAPTER_ID = "usgov-imls-pls"
export const USGOV_IMLS_PLS_DEFAULT_LICENSE = "Public Domain"

const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/

interface ImlsOutletRow {
	LIBNAME: string
	ADDRESS: string
	CITY: string
	ZIP: string
	STABR: string
	CNTY: string
	FSCSKEY: string
}

function splitAddress(address: string): { house_number?: string; street: string } | null {
	const trimmed = address.trim()
	if (!trimmed) return null
	const m = HOUSE_NUMBER_PREFIX.exec(trimmed)
	if (m) return { house_number: m[1], street: m[2]!.trim() }
	return { street: trimmed }
}

export function createUsgovImlsPlsAdapter(): CorpusAdapter {
	return {
		id: USGOV_IMLS_PLS_ADAPTER_ID,
		defaultLicense: USGOV_IMLS_PLS_DEFAULT_LICENSE,
		description: "IMLS Public Libraries Survey — ~17K library outlets with venue+address (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-imls-pls adapter: only US supported, got country=${opts.country}`)
			}

			const stream = createReadStream(opts.inputPath, { encoding: "utf8" })
			const parser = stream.pipe(
				csvParse({
					columns: true,
					skip_empty_lines: true,
					relax_quotes: true,
					relax_column_count: true,
				})
			)

			let emitted = 0
			try {
				for await (const record of parser as AsyncIterable<ImlsOutletRow>) {
					if (opts.signal?.aborted) break
					if (opts.limit !== undefined && emitted >= opts.limit) break

					const libName = (record.LIBNAME ?? "").trim()
					const address = (record.ADDRESS ?? "").trim()
					const city = (record.CITY ?? "").trim()
					const zip = (record.ZIP ?? "").trim()
					const stateAbbr = (record.STABR ?? "").trim()
					const county = (record.CNTY ?? "").trim()

					if (!libName || !city || !zip) continue

					const state = lookupStateAbbreviation(stateAbbr)
					if (!state) continue

					const split = splitAddress(address)
					if (!split) continue

					const components: CanonicalRow["components"] = {
						venue: libName,
						...(split.house_number ? { house_number: split.house_number } : {}),
						street: split.street,
						locality: city,
						region: state.abbreviation,
						postcode: zip,
						// #552: no subregion — US postal addresses don't surface the county, so emitting
						// subregion creates a phantom component with no raw-span to align to, quarantining
						// ~21% of rows. The county is still available in the source CSV; it just isn't
						// a postal-surface component here.
					}

					const streetPart = [split.house_number, split.street].filter(Boolean).join(" ").trim()
					const raw = [
						libName,
						streetPart,
						[city, [stateAbbr, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
					]
						.filter(Boolean)
						.join(", ")

					const aligned = reconcileComponents(components, raw)
					if (Object.keys(aligned).length <= 2) continue

					const fscsKey = (record.FSCSKEY ?? "").trim()
					const sourceId = fscsKey
						? `${USGOV_IMLS_PLS_ADAPTER_ID}-${fscsKey}`
						: stableSourceId(USGOV_IMLS_PLS_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: USGOV_IMLS_PLS_ADAPTER_ID,
						source_id: sourceId,
						corpus_version: "",
						license: USGOV_IMLS_PLS_DEFAULT_LICENSE,
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const usgovImlsPlsAdapter = createUsgovImlsPlsAdapter()
