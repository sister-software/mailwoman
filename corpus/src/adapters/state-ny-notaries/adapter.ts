/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `state-ny-notaries`: New York Commissioned Notaries CSV consumer.
 *
 *   The New York Department of State publishes a registry of commissioned notaries public. Each row
 *   optionally carries a business name and business address (~1-5% fill rate).
 *
 *   The adapter consumes the CSV the operator pre-downloads via `fetch-state-sources.sh`. Column
 *   names match the data.ny.gov export header (note: some columns have leading spaces).
 *
 *   License: stamped `"Public Domain"` per New York state government open-data terms.
 */

import { createReadStream } from "node:fs"

import { parse as csvParse } from "csv-parse"

import { stableSourceId } from "../../adapter.js"
import { lookupStateAbbreviation } from "../../codex/us-fips-state.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const STATE_NY_NOTARIES_ADAPTER_ID = "state-ny-notaries"
export const STATE_NY_NOTARIES_DEFAULT_LICENSE = "Public Domain"

const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/

interface NyNotaryRow {
	"Commission Holder Name": string
	"Commission Number (UID)": string
	"Business Name (if available)": string
	"Business Address 1 (if available)": string
	"Business Address 2 (if available)": string
	" Business City (if available)": string
	"Business State (if available)": string
	"Business Zip (if available)": string
	"Commissioned County": string
}

function splitAddress(address: string): { house_number?: string; street: string } | null {
	const trimmed = address.trim()

	if (!trimmed) return null
	const m = HOUSE_NUMBER_PREFIX.exec(trimmed)

	if (m) return { house_number: m[1], street: m[2]!.trim() }

	return { street: trimmed }
}

const RAW_NY_COLUMNS = [
	"Commission Holder Name",
	"Commission Number (UID)",
	"Business Name (if available)",
	"Business Address 1 (if available)",
	"Business Address 2 (if available)",
	" Business City (if available)",
	"Business State (if available)",
	"Business Zip (if available)",
	"Commissioned County",
] as const

export function createStateNyNotariesAdapter(): CorpusAdapter {
	return {
		id: STATE_NY_NOTARIES_ADAPTER_ID,
		defaultLicense: STATE_NY_NOTARIES_DEFAULT_LICENSE,
		description: "New York Commissioned Notaries — name + optional business address (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`state-ny-notaries adapter: only US supported, got country=${opts.country}`)
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
				for await (const rawRecord of parser as AsyncIterable<Record<string, string>>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					// NY CSV has columns with leading spaces, so we normalize by trimming keys.
					const record: Record<string, string> = {}

					for (const key of Object.keys(rawRecord)) {
						record[key.trim()] = rawRecord[key] ?? ""
					}

					const holderName = (record["Commission Holder Name"] ?? "").trim()
					const businessName = (record["Business Name (if available)"] ?? "").trim()
					const address1 = (record["Business Address 1 (if available)"] ?? "").trim()
					const address2 = (record["Business Address 2 (if available)"] ?? "").trim()
					const city = (record["Business City (if available)"] ?? "").trim()
					const stateAbbr = (record["Business State (if available)"] ?? "").trim()
					const zip = (record["Business Zip (if available)"] ?? "").trim()
					const county = (record["Commissioned County"] ?? "").trim()

					if (!city || !stateAbbr || !zip) continue

					if (!address1 && !address2) continue

					const state = lookupStateAbbreviation(stateAbbr)

					if (!state) continue

					const fullAddress = [address1, address2].filter(Boolean).join(" ")
					const split = splitAddress(fullAddress)

					if (!split) continue

					const venue = businessName || holderName || undefined

					const components: CanonicalRow["components"] = {
						...(venue ? { venue } : {}),
						...(split.house_number ? { house_number: split.house_number } : {}),
						street: split.street,
						locality: city,
						region: state.abbreviation,
						postcode: zip,
						...(county ? { subregion: county } : {}),
					}

					const streetPart = [split.house_number, split.street].filter(Boolean).join(" ").trim()
					const raw = [venue, streetPart, [city, [stateAbbr, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")]
						.filter(Boolean)
						.join(", ")

					const aligned = reconcileComponents(components, raw)

					if (Object.keys(aligned).length <= 2) continue

					const commNum = (record["Commission Number (UID)"] ?? "").trim()
					const sourceId = commNum
						? `${STATE_NY_NOTARIES_ADAPTER_ID}-${commNum}`
						: stableSourceId(STATE_NY_NOTARIES_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: STATE_NY_NOTARIES_ADAPTER_ID,
						source_id: sourceId,
						corpus_version: "",
						license: STATE_NY_NOTARIES_DEFAULT_LICENSE,
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const stateNyNotariesAdapter = createStateNyNotariesAdapter()
