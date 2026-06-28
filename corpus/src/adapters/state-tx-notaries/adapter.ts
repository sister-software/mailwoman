/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `state-tx-notaries`: Texas Notary Public Commissions CSV consumer.
 *
 *   The Texas Secretary of State publishes a registry of commissioned notaries public. Each row
 *   optionally carries a mailing address in free-form text (often multi-line with embedded
 *   city/state/zip). Address fill rate is ~5-10%.
 *
 *   The adapter parses the embedded `Address` field for city/state/zip using a trailing `"CITY, ST
 *   ZIP"` pattern.
 *
 *   License: stamped `"Public Domain"` per Texas state government open-data terms.
 */

import { createReadStream } from "node:fs"

import { parse as csvParse } from "csv-parse"

import { stableSourceId } from "../../adapter.js"
import { lookupStateAbbreviation } from "../../codex/us-fips-state.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const STATE_TX_NOTARIES_ADAPTER_ID = "state-tx-notaries"
export const STATE_TX_NOTARIES_DEFAULT_LICENSE = "Public Domain"

const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/

/** Match trailing "CITY, ST ZIP" or "CITY, ST" at the end of an address line. */
const CITY_STATE_ZIP_SUFFIX = /[,]?\s*([^,]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?\s*$/i

interface TxNotaryRow {
	"Notary ID": string
	"First Name": string
	"Last Name": string
	Address: string
}

function splitAddress(address: string): { house_number?: string; street: string } | null {
	const trimmed = address.trim()

	if (!trimmed) return null
	const m = HOUSE_NUMBER_PREFIX.exec(trimmed)

	if (m) return { house_number: m[1], street: m[2]!.trim() }

	return { street: trimmed }
}

export function createStateTxNotariesAdapter(): CorpusAdapter {
	return {
		id: STATE_TX_NOTARIES_ADAPTER_ID,
		defaultLicense: STATE_TX_NOTARIES_DEFAULT_LICENSE,
		description:
			"Texas Notary Public Commissions — name + mailing address with embedded city/state/zip (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`state-tx-notaries adapter: only US supported, got country=${opts.country}`)
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
				for await (const record of parser as AsyncIterable<TxNotaryRow>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const rawAddress = (record.Address ?? "").trim()

					if (!rawAddress) continue

					const firstName = (record["First Name"] ?? "").trim()
					const lastName = (record["Last Name"] ?? "").trim()
					const notaryId = (record["Notary ID"] ?? "").trim()

					// Parse embedded city/state/zip from the trailing portion of the address.
					// Addresses look like: "1215 MCMILLAN DR\nCEDAR HILL, TX 75104"
					const addrSingleLine = rawAddress.replace(/\n/g, ", ")
					const cszMatch = CITY_STATE_ZIP_SUFFIX.exec(addrSingleLine)

					if (!cszMatch) continue

					const city = (cszMatch[1] ?? "").trim()
					const stateAbbr = (cszMatch[2] ?? "").trim()
					const zip = (cszMatch[3] ?? "").trim()

					if (!city || !stateAbbr) continue

					const state = lookupStateAbbreviation(stateAbbr)

					if (!state) continue

					// Extract the street portion (everything before the city/state/zip)
					const streetPortion = addrSingleLine.slice(0, cszMatch.index).replace(/,\s*$/, "").trim()

					if (!streetPortion) continue

					const split = splitAddress(streetPortion)

					if (!split) continue

					const venue = [firstName, lastName].filter(Boolean).join(" ") || undefined

					const components: CanonicalRow["components"] = {
						...(venue ? { venue } : {}),
						...(split.house_number ? { house_number: split.house_number } : {}),
						street: split.street,
						locality: city,
						region: state.abbreviation,
						...(zip ? { postcode: zip } : {}),
					}

					const streetPart = [split.house_number, split.street].filter(Boolean).join(" ").trim()
					const raw = [venue, streetPart, [city, [stateAbbr, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")]
						.filter(Boolean)
						.join(", ")

					const aligned = reconcileComponents(components, raw)

					if (Object.keys(aligned).length <= 2) continue

					const sourceId = notaryId
						? `${STATE_TX_NOTARIES_ADAPTER_ID}-${notaryId}`
						: stableSourceId(STATE_TX_NOTARIES_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: STATE_TX_NOTARIES_ADAPTER_ID,
						source_id: sourceId,
						corpus_version: "",
						license: STATE_TX_NOTARIES_DEFAULT_LICENSE,
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const stateTxNotariesAdapter = createStateTxNotariesAdapter()
