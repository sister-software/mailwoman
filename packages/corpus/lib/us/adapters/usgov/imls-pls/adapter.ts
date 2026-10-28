/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-imls-pls`: IMLS Public Libraries Survey outlet CSV consumer.
 *
 *   The Institute of Museum and Library Services publishes an annual Public Libraries Survey with one
 *   row per library outlet (~17K rows). Each row includes the library name, street address, city,
 *   ZIP, county and geocoordinates.
 *
 *   The adapter consumes the outlet CSV the operator pre-downloads via `fetch-imls-pls.ts`. Column
 *   names match the IMLS PLS outlet file header.
 *
 *   Output: one row per outlet with `venue` (library name), `(house_number, street, locality,
 *   subregion, postcode)`, and lat/lon preserved in `source_id` stability.
 *
 *   License: stamped `"Public Domain"` per IMLS federal government distribution terms.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { CSVSpliterator } from "spliterator"

import { rawTextDiscriminator, rowSourceID } from "#adapters/record-id"
import { stableSourceID } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { lookupStateAbbreviation } from "#us/fips-state"
import { splitUSStreetLine } from "#us/street-unit"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const USGOV_IMLS_PLS_ADAPTER_ID = "usgov-imls-pls"
/**
 * License assigned by this source (Public Domain), attached to each row so downstream
 * consumers inherit the terms rather than having to look them up.
 */
export const USGOV_IMLS_PLS_DEFAULT_LICENSE = "Public Domain"

interface ImlsOutletRow {
	LIBNAME: string
	ADDRESS: string
	CITY: string
	ZIP: string
	STABR: string
	CNTY: string
	FSCSKEY: string
	FSCS_SEQ: string
}

export function createUSGovIMLSPLSAdapter(): CorpusAdapter {
	return {
		id: USGOV_IMLS_PLS_ADAPTER_ID,
		defaultLicense: USGOV_IMLS_PLS_DEFAULT_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.IMLSPublicLibraries,
		surface: SurfaceOrigin.Rendered,
		description: "IMLS Public Libraries Survey — ~17K library outlets with venue+address (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-imls-pls adapter: only US supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<ImlsOutletRow>) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const libName = record.LIBNAME ?? ""
				const address = record.ADDRESS ?? ""
				const city = record.CITY ?? ""
				const zip = record.ZIP ?? ""
				const stateAbbr = record.STABR ?? ""

				if (!libName || !city || !zip) continue

				const state = lookupStateAbbreviation(stateAbbr)

				if (!state) continue

				const line = splitUSStreetLine(address)

				if (!line) continue

				const components: CanonicalRow["components"] = {
					venue: libName,
					...line,
					locality: city,
					region: state.abbreviation,
					postcode: zip,
					// No subregion: US postal addresses don't surface the county, so emitting subregion
					// creates a phantom component with no raw-span to align to, quarantining ~21% of rows.
					// The county is still available in the source CSV.
					// It is not a postal-surface component here.
				}

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				if (Object.keys(aligned).length <= 2) continue

				const fscsKey = record.FSCSKEY ?? ""

				// FSCSKEY identifies the library system, and every outlet of a system shares it.
				// The record is the system, and the outlet's FSCS_SEQ tells its rows apart (#2765).
				const sourceID = fscsKey
					? rowSourceID(`${USGOV_IMLS_PLS_ADAPTER_ID}-${fscsKey}`, record.FSCS_SEQ || rawTextDiscriminator(raw))
					: stableSourceID(USGOV_IMLS_PLS_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: USGOV_IMLS_PLS_ADAPTER_ID,
					source_id: sourceID,
					license: USGOV_IMLS_PLS_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const usgovImlsPlsAdapter = createUSGovIMLSPLSAdapter()
