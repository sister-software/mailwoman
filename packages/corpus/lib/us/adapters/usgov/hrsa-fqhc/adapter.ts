/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-hrsa-fqhc`: HRSA "Health Center Service Delivery Site Locations" CSV consumer.
 *
 *   Federally Qualified Health Centers (FQHCs) are HRSA-funded community health programs.
 *   They self-report site addresses to the HRSA Data Warehouse. The published CSV (`data.hrsa.gov`)
 *   includes the site name, postal-formatted street address, locality, region and postcode.
 *   Each facility name is a human-typed venue string. Multiple people have edited each address.
 *   That editing introduces abbreviation drift and suite designators absent from gazetteer data.
 *
 *   The adapter consumes a CSV file the operator pre-downloads. The HRSA data is published as a
 *   single national CSV (~10K rows), small enough that the operator can re-fetch on every corpus
 *   rebuild without an intermediate SQLite step. Column names below match the HRSA Data Warehouse's
 *   "Health Center Service Delivery Site" public dataset. Operators substituting the
 *   closely-related "Site Address" or "Health Center" public extracts may need to remap columns.
 *   the readme documents the expected set.
 *
 *   Output: one row per CSV record, with `venue` component carrying the site name and the address
 *   quad on `(house_number, street, locality, region, postcode)`. Component order is critical:
 *   `venue` is inserted first so alignment claims its surface span before `locality` searches for
 *   its own (the kryptonite case "Buffalo Health Clinic, …, Buffalo, NY" relies on `venue`
 *   consuming the first "Buffalo" so locality lands on the second).
 *
 *   License: stamped `"Public Domain"` per the HRSA Data Warehouse's federal government distribution
 *   terms.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { CSVSpliterator } from "spliterator"

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
export const USGOV_HRSA_FQHC_ADAPTER_ID = "usgov-hrsa-fqhc"
/**
 * License assigned by this source (Public Domain), attached to each row so downstream
 * consumers inherit the terms rather than having to look them up.
 */
export const USGOV_HRSA_FQHC_DEFAULT_LICENSE = "Public Domain"

/**
 * Subset of HRSA "Health Center Service Delivery Site Locations" CSV columns consulted by the adapter.
 *
 * Column names match the canonical HRSA Data Warehouse export header.
 * Operators substituting a closely-related extract should rename columns to match.
 * The readme has the mapping cheatsheet.
 */
interface HRSASiteRow {
	"Site Name": string
	"Site Address": string
	"Site City": string
	"Site State Abbreviation": string
	"Site Postal Code": string
	/**
	 * Optional.
	 *
	 * Falls back to `stableSourceID` derived from components when missing.
	 */
	"Site ID"?: string
}

/**
 * Creates the HRSA adapter.
 *
 * HRSA writes a site's suite at the end of its one address column (`1401 Atlantic Ave STE 2100`).
 * `splitUSStreetLine` moves it into `unit` and a whole-line PO box into `po_box`,
 * the labels every US register adapter writes for those forms.
 */
export function createUSGovHRSAFQHCAdapter(): CorpusAdapter {
	return {
		id: USGOV_HRSA_FQHC_ADAPTER_ID,
		defaultLicense: USGOV_HRSA_FQHC_DEFAULT_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.HRSAHealthCenters,
		surface: SurfaceOrigin.Rendered,
		description:
			"HRSA Federally Qualified Health Center site locations (public-domain). Adversarial source: venue + address co-occurrence, hand-entered.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-hrsa-fqhc adapter: only US supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<HRSASiteRow>) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const venue = record["Site Name"] ?? ""
				const line = splitUSStreetLine(record["Site Address"] ?? "")
				const city = record["Site City"] ?? ""
				const stateAbbr = record["Site State Abbreviation"] ?? ""
				const postcode = record["Site Postal Code"] ?? ""

				if (!venue || !line || !city || !postcode) continue
				const state = lookupStateAbbreviation(stateAbbr)

				if (!state) continue

				// Insertion order matters here.
				// `venue` first so alignment claims its span (which may contain a token like "Buffalo")
				// before `locality` runs its search — the kryptonite case `Buffalo Health Clinic, Buffalo NY`
				// otherwise mis-labels the venue's "Buffalo" as locality.
				const components: CanonicalRow["components"] = {
					venue,
					...line,
					locality: city,
					region: state.abbreviation,
					postcode,
				}

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				const siteID = record["Site ID"] ?? ""

				const sourceID = siteID
					? `${USGOV_HRSA_FQHC_ADAPTER_ID}-${siteID}`
					: stableSourceID(USGOV_HRSA_FQHC_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: USGOV_HRSA_FQHC_ADAPTER_ID,
					source_id: sourceID,
					license: USGOV_HRSA_FQHC_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const usgovHrsaFqhcAdapter = createUSGovHRSAFQHCAdapter()
