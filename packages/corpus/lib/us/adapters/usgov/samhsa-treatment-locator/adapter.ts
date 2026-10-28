/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-samhsa-treatment-locator`: samhsa Behavioral Health Treatment Services Locator CSV
 *   consumer.
 *
 *   samhsa's Treatment Locator (`findtreatment.gov`) is the federal directory of substance-use and
 *   mental-health treatment facilities. The published CSV includes the facility name, an optional
 *   secondary name (typically the organizational parent), and the postal address quad split into
 *   primary + secondary street lines. Phase 1.6 §1.2 selects this source for the same reason
 *   it selects HRSA: facility names are hand-typed venue strings and the addresses pass through
 *   enough human + system hands to accumulate the suite-designator + sub-tenant chaos ("Suite C,
 *   behind main building") that pure gazetteer data does not.
 *
 *   samhsa writes an address on two lines. `street1` holds the postal street line (`"123 Main St"`)
 *   and `street2` the suite or floor (`"Suite 300"`). `splitUSStreetLine` splits `street1`, and
 *   `unitLine` keeps `street2` as the `unit` when it opens with a USPS designator, the labels every US
 *   register adapter writes for those forms.
 *
 *   Column names below match the canonical samhsa Behavioral Health Treatment Services Locator CSV
 *   export header. Operators substituting a closely-related extract should rename columns to match.
 *   the readme has the mapping cheatsheet.
 *
 *   License: stamped `"Public Domain"` per the samhsa Open Data Foundry's federal-government
 *   distribution terms.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { isPresent } from "@mailwoman/core/objects"
import { CSVSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { lookupStateAbbreviation } from "#us/fips-state"
import { splitUSStreetLine, unitLine } from "#us/street-unit"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const USGOV_SAMHSA_ADAPTER_ID = "usgov-samhsa-treatment-locator"
/**
 * License assigned by this source (Public Domain), attached to each row so downstream
 * consumers inherit the terms rather than having to look them up.
 */
export const USGOV_SAMHSA_DEFAULT_LICENSE = "Public Domain"

/**
 * Subset of samhsa Treatment Locator CSV columns consulted by the adapter.
 *
 * Column names match the canonical samhsa Open Data Foundry export header.
 * `name1` is the venue; `name2` is optional and folded into the venue when present.
 */
interface SamhsaSiteRow {
	name1: string
	name2?: string
	street1: string
	street2?: string
	city: string
	state: string
	zip: string
	/**
	 * Optional.
	 *
	 * Falls back to `stableSourceID` derived from components when missing.
	 */
	frid?: string
}

/**
 * Combine `name1` + optional `name2` into a single venue surface form.
 * Samhsa conventions:
 *
 * - `name1` is the program / clinic name ("Mountain Plains Counseling Services").
 * - `name2` is the parent organization ("Catholic Charities of Wyoming"), if any.
 *
 * Both render together as `"<name1> - <name2>"` when both are present — geocoder users
 * typically type either form, so the model benefits from the joined surface.
 */
function composeVenue(name1: string, name2: string | null): string {
	const n1 = name1.trim()
	const n2 = (name2 ?? "").trim()

	if (!n1 && !n2) return ""

	if (!n2) return n1

	if (!n1) return n2

	return `${n1} - ${n2}`
}

export function createUsgovSamhsaTreatmentLocatorAdapter(): CorpusAdapter {
	return {
		id: USGOV_SAMHSA_ADAPTER_ID,
		defaultLicense: USGOV_SAMHSA_DEFAULT_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.SAMHSATreatmentLocator,
		surface: SurfaceOrigin.Rendered,
		description:
			"SAMHSA Behavioral Health Treatment Services Locator (public-domain). Adversarial source: venue + two-line address co-occurrence, hand-entered.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-samhsa adapter: only US supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<SamhsaSiteRow>) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const venue = composeVenue(record.name1 ?? "", record.name2 ?? null)
				const line = splitUSStreetLine(record.street1 ?? "")
				// A unit on the first line comes before one on the second, the order the publisher wrote them.
				// A second line that opens with no designator, such as `2nd Floor`, stays out of the row.
				const firstUnit = line && "street" in line ? line.unit : undefined
				const unit = [firstUnit, unitLine(record.street2 ?? "")].filter(isPresent).join(" ")
				const city = record.city ?? ""
				const stateAbbr = record.state ?? ""
				const postcode = record.zip ?? ""

				if (!venue || !line || !city || !postcode) continue
				const state = lookupStateAbbreviation(stateAbbr)

				if (!state) continue

				// venue first — same kryptonite-defending insertion order as HRSA.
				const components: CanonicalRow["components"] = {
					venue,
					...line,
					...(unit ? { unit } : {}),
					locality: city,
					region: state.abbreviation,
					postcode,
				}

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				const frID = record.frid ?? ""

				const sourceID = frID ? `${USGOV_SAMHSA_ADAPTER_ID}-${frID}` : stableSourceID(USGOV_SAMHSA_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: USGOV_SAMHSA_ADAPTER_ID,
					source_id: sourceID,
					license: USGOV_SAMHSA_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const usgovSamhsaTreatmentLocatorAdapter = createUsgovSamhsaTreatmentLocatorAdapter()
