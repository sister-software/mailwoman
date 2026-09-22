/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-nppes`: CMS National Plan and Provider Enumeration System (NPI registry) CSV consumer.
 *
 *   NPPES is the authoritative US healthcare provider registry, published monthly by CMS. Each row
 *   carries a provider's business practice location address together with their legal business name
 *   or individual name. At ~7M rows it is the single largest venue+address signal source
 *   available.
 *
 *   The adapter consumes the monthly full-replacement CSV (operator pre-downloads via
 *   `fetch-nppes.ts`). Column names match the canonical NPPES "Full Replacement Monthly NPI File"
 *   header published at `https://download.cms.gov/nppes/NPI_Files.html`.
 *
 *   Output: one row per CSV record where the practice location address is populated. Organization
 *   rows carry `venue` from the legal business name. individual rows compose `attention` from
 *   last+first name. Address quad goes on `(house_number, street, locality, region, postcode)`.
 *
 *   License: stamped `"Public Domain"` per CMS's federal government distribution terms.
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { formatPersonName } from "@mailwoman/record/name"
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
export const USGOV_NPPES_ADAPTER_ID = "usgov-nppes"
/**
 * License carried by this source (Public Domain), attached to each row so downstream
 * consumers inherit the terms rather than having to look them up.
 */
export const USGOV_NPPES_DEFAULT_LICENSE = "Public Domain"

interface NPPESRow {
	NPI: string
	"Entity Type Code": string
	"Provider Organization Name (Legal Business Name)": string
	"Provider Last Name (Legal Name)": string
	"Provider First Name": string
	"Provider First Line Business Practice Location Address": string
	"Provider Second Line Business Practice Location Address": string
	"Provider Business Practice Location Address City Name": string
	"Provider Business Practice Location Address State Name": string
	// CMS's own column name, and the publisher's spelling is the correct one.
	// A vocabulary sweep rewrote it to `Postcode` on 2026-09-11 (`f5a98e7b4`); `record[…]`
	// then read `undefined` on every row, `if (!city || !postcode) continue` dropped all of them,
	// and the adapter reported `yielded: 0` after reading 11.4 GB without raising.
	"Provider Business Practice Location Address Postal Code": string
}

/**
 * The columns every emitted row needs, in CMS's own spelling.
 *
 * Each is read by name off a parsed record, so a column this file does not carry reads
 * `undefined` rather than raising, and the row filter below drops the row.
 * Silently, and for every row.
 */
const REQUIRED_COLUMNS = [
	"Provider First Line Business Practice Location Address",
	"Provider Business Practice Location Address City Name",
	"Provider Business Practice Location Address State Name",
	"Provider Business Practice Location Address Postal Code",
] as const

/**
 * Refuse a file whose practice-location columns this adapter cannot find.
 *
 * Checked against the first parsed record rather than the header line, so it sees the
 * keys the reader produced rather than the bytes the file opened with.
 */
function assertPracticeLocationColumns(record: NPPESRow, inputPath: string): void {
	const present = new Set(Object.keys(record))
	const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column))

	if (!missing.length) return

	throw new Error(
		`usgov-nppes adapter: ${inputPath} carries none of ${missing.map((column) => stringifyJSON(column)).join(", ")}. ` +
			`Every row would be dropped and the run would report zero rows read from a file it read in full. ` +
			`Check the publisher's own spelling against this adapter's column names.`
	)
}

export function createUsgovNPPESAdapter(): CorpusAdapter {
	return {
		id: USGOV_NPPES_ADAPTER_ID,
		defaultLicense: USGOV_NPPES_DEFAULT_LICENSE,
		addressRole: AddressRole.Practice,
		register: SourceRegister.NPPES,
		surface: SurfaceOrigin.Attested,
		description:
			"CMS National Plan and Provider Enumeration System — 7M provider practice locations (public-domain). Venue+address co-occurrence at scale.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-nppes adapter: only US supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
			})

			let emitted = 0
			let checkedHeader = false

			for await (const record of rows as AsyncIterable<NPPESRow>) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const npi = (record.NPI ?? "").trim()
				const orgName = (record["Provider Organization Name (Legal Business Name)"] ?? "").trim()
				const lastName = (record["Provider Last Name (Legal Name)"] ?? "").trim()
				const firstName = (record["Provider First Name"] ?? "").trim()

				const address1 = (record["Provider First Line Business Practice Location Address"] ?? "").trim()
				const address2 = (record["Provider Second Line Business Practice Location Address"] ?? "").trim()
				const city = (record["Provider Business Practice Location Address City Name"] ?? "").trim()
				const stateRaw = (record["Provider Business Practice Location Address State Name"] ?? "").trim()
				const postcode = (record["Provider Business Practice Location Address Postal Code"] ?? "").trim()

				// A column this file does not carry reads `undefined` for every row, and the two
				// `continue`s below then drop every row while the adapter reports a clean run.
				// Checking the first record's keys turns a column rename into a refusal that names the column.
				if (!checkedHeader) {
					checkedHeader = true
					assertPracticeLocationColumns(record, opts.inputPath)
				}

				if (!city || !postcode) continue

				const state = lookupStateAbbreviation(stateRaw)

				if (!state) continue

				const fullStreet = [address1, address2].filter(isPresent).join(" ")
				const split = splitStreetLine(fullStreet)

				if (!split) continue

				const venue = orgName || formatPersonName({ given: firstName, family: lastName }, "short") || undefined

				const components: CanonicalRow["components"] = {
					...(venue ? { venue } : {}),
					...(split.house_number ? { house_number: split.house_number } : {}),
					street: split.street,
					locality: city,
					region: state.abbreviation,
					postcode,
				}

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				if (Object.keys(aligned).length <= 2) continue

				const sourceID = npi ? `${USGOV_NPPES_ADAPTER_ID}-${npi}` : stableSourceID(USGOV_NPPES_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: USGOV_NPPES_ADAPTER_ID,
					source_id: sourceID,
					corpus_version: "",
					license: USGOV_NPPES_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const usgovNPPESAdapter = createUsgovNPPESAdapter()
