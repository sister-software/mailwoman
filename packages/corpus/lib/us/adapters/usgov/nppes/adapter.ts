/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads provider practice-location addresses from the monthly CMS NPPES full-replacement CSV.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { matchLeadingDesignator } from "@mailwoman/codex/us/unit-designator"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { formatPersonName } from "@mailwoman/record/name"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/source-id"
import { splitStreetLine } from "#adapters/street-line"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { lookupStateAbbreviation } from "#us/fips-state"
import { splitTrailingUnit } from "#us/street-unit"

/**
 * The adapter stamps this id on every emitted row.
 */
export const USGOV_NPPES_ADAPTER_ID = "usgov-nppes"
/**
 * The license label on every emitted row, because CMS distributes NPPES as a federal public-domain work.
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
	// This is the publisher's exact column name, so the string keeps the publisher's spelling.
	"Provider Business Practice Location Address Postal Code": string
}

/**
 * The columns that every emitted row needs, in the publisher's spelling.
 *
 * A missing column reads as `undefined` on every record.
 * The row filter would then drop every row without an error.
 */
const REQUIRED_COLUMNS = [
	"Provider First Line Business Practice Location Address",
	"Provider Business Practice Location Address City Name",
	"Provider Business Practice Location Address State Name",
	"Provider Business Practice Location Address Postal Code",
] as const

/**
 * Throws when the first parsed record lacks a required practice-location column.
 *
 * The check reads the parsed record's keys, so it sees the column names exactly
 * as the CSV reader produced them.
 */
function assertPracticeLocationColumns(record: NPPESRow, inputPath: PathBuilderLike): void {
	const present = new Set(Object.keys(record))
	const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column))

	if (!missing.length) return

	throw new Error(
		`usgov-nppes adapter: ${inputPath} carries none of ${missing.map((column) => stringifyJSON(column)).join(", ")}. ` +
			`Every row would be dropped and the run would report zero rows read from a file it read in full. ` +
			`Check the publisher's own spelling against this adapter's column names.`
	)
}

/**
 * The second practice-location line as a unit, or `null` when it holds something else.
 *
 * Most filled second lines open with a USPS secondary unit designator
 * (`SUITE 200`, `STE. 4`, `APT 2B`, `DEPARTMENT OF SURGERY`) or a bare number sign (`#200`).
 * The rest name a recipient, a building or a mail stop (`ATTN: BILLING`, `C/O …`, `MEDICAL OFFICE BUILDING`).
 *
 * Those are not part of the street or the unit, so the row leaves them out
 * rather than joining them to the street span.
 */
export function unitLine(line: string): string | null {
	if (!line) return null

	if (/^#\s*\w/.test(line)) return line

	const [first = ""] = line.split(/\s+/)

	return matchLeadingDesignator(first.replace(/\.$/, "")) ? line : null
}

/**
 * Creates the NPPES adapter.
 *
 * Each row's `venue` is the organization's legal name or, for an individual provider,
 * the formatted person name.
 * The adapter skips records without a city, a postcode, a known state or a parseable street line.
 */
export function createUsgovNPPESAdapter(): CorpusAdapter {
	return {
		id: USGOV_NPPES_ADAPTER_ID,
		defaultLicense: USGOV_NPPES_DEFAULT_LICENSE,
		addressRole: AddressRole.Practice,
		register: SourceRegister.NPPES,
		surface: SurfaceOrigin.Rendered,
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

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				// NPPES pads some values with trailing spaces (`… CENTER LLC `),
				// and a padded value renders into a span that ends on the space.
				const column = (name: keyof NPPESRow) => (record[name] ?? "").trim()
				const npi = column("NPI")
				const orgName = column("Provider Organization Name (Legal Business Name)")
				const lastName = column("Provider Last Name (Legal Name)")
				const firstName = column("Provider First Name")

				const address1 = column("Provider First Line Business Practice Location Address")
				const address2 = column("Provider Second Line Business Practice Location Address")
				const city = column("Provider Business Practice Location Address City Name")
				const stateRaw = column("Provider Business Practice Location Address State Name")
				const postcode = column("Provider Business Practice Location Address Postal Code")

				// The first record's keys reveal a renamed column before the filters below drop every row.
				if (!checkedHeader) {
					checkedHeader = true
					assertPracticeLocationColumns(record, opts.inputPath)
				}

				if (!city || !postcode) continue

				const state = lookupStateAbbreviation(stateRaw)

				if (!state) continue

				const split = splitStreetLine(address1)

				if (!split) continue

				// A unit written on the first line (`2560 HUNTINGTON AVE STE 302`) is split off the street,
				// and one on the second line follows it, so the rendered row keeps the publisher's order.
				const trailing = splitTrailingUnit(split.street)
				const street = trailing?.street ?? split.street
				const unit = [trailing?.unit, unitLine(address2)].filter(isPresent).join(" ")

				const venue = orgName || formatPersonName({ given: firstName, family: lastName }, "short") || undefined

				const components: CanonicalRow["components"] = {
					...(venue ? { venue } : {}),
					...(split.house_number ? { house_number: split.house_number } : {}),
					street,
					...(unit ? { unit } : {}),
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
					license: USGOV_NPPES_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The NPPES adapter instance that the corpus builder registers.
 */
export const usgovNPPESAdapter = createUsgovNPPESAdapter()
