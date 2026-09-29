/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `state-ny-notaries`: New York Commissioned Notaries CSV consumer.
 *
 *   The New York Department of State publishes a registry of commissioned notaries public. Each row
 *   optionally includes a business name and business address (~1-5% fill rate).
 *
 *   The adapter consumes the CSV the operator pre-downloads via `fetch-state-sources.ts`. Column
 *   names match the data.ny.gov export header (note: some columns have leading spaces).
 *
 *   License: stamped `"Public Domain"` per New York state government open-data terms.
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { isPresent } from "@mailwoman/core/objects"
import { CSVSpliterator } from "spliterator"

import { splitStreetLine, stableSourceID } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { lookupStateAbbreviation } from "#us/fips-state"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const STATE_NY_NOTARIES_ADAPTER_ID = "state-ny-notaries"
/**
 * License assigned by this source (Public Domain), attached to each row so downstream
 * consumers inherit the terms rather than having to look them up.
 */
export const STATE_NY_NOTARIES_DEFAULT_LICENSE = "Public Domain"

export function createStateNyNotariesAdapter(): CorpusAdapter {
	return {
		id: STATE_NY_NOTARIES_ADAPTER_ID,
		defaultLicense: STATE_NY_NOTARIES_DEFAULT_LICENSE,
		addressRole: AddressRole.Practice,
		register: SourceRegister.NewYorkNotaries,
		surface: SurfaceOrigin.Rendered,
		description: "New York Commissioned Notaries — name + optional business address (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`state-ny-notaries adapter: only US supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<Record<string, string>>) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const holderName = record["Commission Holder Name"] ?? ""
				const businessName = record["Business Name (if available)"] ?? ""
				const address1 = record["Business Address 1 (if available)"] ?? ""
				const address2 = record["Business Address 2 (if available)"] ?? ""
				const city = record["Business City (if available)"] ?? ""
				const stateAbbr = record["Business State (if available)"] ?? ""
				const zip = record["Business Zip (if available)"] ?? ""
				const county = record["Commissioned County"] ?? ""

				if (!city || !stateAbbr || !zip) continue

				if (!address1 && !address2) continue

				const state = lookupStateAbbreviation(stateAbbr)

				if (!state) continue

				const fullAddress = [address1, address2].filter(isPresent).join(" ")
				const split = splitStreetLine(fullAddress)

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

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				if (Object.keys(aligned).length <= 2) continue

				const commNum = record["Commission Number (UID)"] ?? ""

				const sourceID = commNum
					? `${STATE_NY_NOTARIES_ADAPTER_ID}-${commNum}`
					: stableSourceID(STATE_NY_NOTARIES_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: STATE_NY_NOTARIES_ADAPTER_ID,
					source_id: sourceID,
					corpus_version: "",
					license: STATE_NY_NOTARIES_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const stateNyNotariesAdapter = createStateNyNotariesAdapter()
