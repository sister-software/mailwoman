/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `state-ia-contractors`: Iowa Active Construction Contractor Registrations CSV consumer.
 *
 *   Iowa Workforce Development publishes a public registry of active construction contractors. Each
 *   row carries a business name, street address, city/state/zip, and contact info.
 *
 *   The adapter consumes the CSV the operator pre-downloads via `fetch-state-sources.ts`.
 *
 *   Output: one row per contractor with `venue` (business name) and address quad `(house_number,
 *   street, locality, region, postcode)`.
 *
 *   License: stamped `"Public Domain"` per Iowa state government open-data terms.
 */

import { createReadStream } from "node:fs"

import { parse as csvParse } from "csv-parse"

import { stableSourceID } from "../../adapter.js"
import { lookupStateAbbreviation } from "../../codex/us-fips-state.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const STATE_IA_CONTRACTORS_ADAPTER_ID = "state-ia-contractors"
export const STATE_IA_CONTRACTORS_DEFAULT_LICENSE = "Public Domain"

const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/

interface IaContractorRow {
	"Registration #": string
	"Business Name": string
	"Address 1": string
	"Address 2": string
	City: string
	State: string
	"Zip Code": string
	"First Name": string
	"Last Name": string
}

function splitAddress(address: string): { house_number?: string; street: string } | null {
	const trimmed = address.trim()

	if (!trimmed) return null
	const m = HOUSE_NUMBER_PREFIX.exec(trimmed)

	if (m) return { house_number: m[1], street: m[2]!.trim() }

	return { street: trimmed }
}

export function createStateIaContractorsAdapter(): CorpusAdapter {
	return {
		id: STATE_IA_CONTRACTORS_ADAPTER_ID,
		defaultLicense: STATE_IA_CONTRACTORS_DEFAULT_LICENSE,
		description:
			"Iowa Active Construction Contractor Registrations — business name + full street address (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`state-ia-contractors adapter: only US supported, got country=${opts.country}`)
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
				for await (const record of parser as AsyncIterable<IaContractorRow>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const businessName = (record["Business Name"] ?? "").trim()
					const address1 = (record["Address 1"] ?? "").trim()
					const address2 = (record["Address 2"] ?? "").trim()
					const city = (record.City ?? "").trim()
					const stateAbbr = (record.State ?? "").trim()
					const zip = (record["Zip Code"] ?? "").trim()

					if (!city || !zip) continue

					const state = lookupStateAbbreviation(stateAbbr)

					if (!state) continue

					const fullAddress = [address1, address2].filter(Boolean).join(" ")
					const split = splitAddress(fullAddress)

					if (!split) continue

					const venue = businessName || undefined

					const components: CanonicalRow["components"] = {
						...(venue ? { venue } : {}),
						...(split.house_number ? { house_number: split.house_number } : {}),
						street: split.street,
						locality: city,
						region: state.abbreviation,
						postcode: zip,
					}

					const streetPart = [split.house_number, split.street].filter(Boolean).join(" ").trim()
					const raw = [venue, streetPart, [city, [stateAbbr, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")]
						.filter(Boolean)
						.join(", ")

					const aligned = reconcileComponents(components, raw)

					if (Object.keys(aligned).length <= 2) continue

					const regNum = (record["Registration #"] ?? "").trim()
					const sourceID = regNum
						? `${STATE_IA_CONTRACTORS_ADAPTER_ID}-${regNum}`
						: stableSourceID(STATE_IA_CONTRACTORS_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: STATE_IA_CONTRACTORS_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: STATE_IA_CONTRACTORS_DEFAULT_LICENSE,
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const stateIaContractorsAdapter = createStateIaContractorsAdapter()
