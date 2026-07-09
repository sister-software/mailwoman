/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-samhsa-treatment-locator`: SAMHSA Behavioral Health Treatment Services Locator CSV
 *   consumer.
 *
 *   SAMHSA's Treatment Locator (`findtreatment.gov`) is the federal directory of substance-use and
 *   mental-health treatment facilities. The published CSV carries the facility name, an optional
 *   secondary name (typically the organizational parent), and the postal address quad split into
 *   primary + secondary street lines. Phase 1.6 §1.2 (#22) selects this source for the same reason
 *   it selects HRSA: facility names are hand-typed venue strings and the addresses pass through
 *   enough human + system hands to accumulate the suite-designator + sub-tenant chaos ("Suite C,
 *   behind main building") that pure gazetteer data does not.
 *
 *   SAMHSA's two-line address shape is the key adapter-specific concern. `street1` typically carries
 *   the canonical postal address (`"123 Main St"`); `street2` carries the suite / unit / "second
 *   floor" surface form. The adapter joins them with `", "` into a single `street` component (Phase
 *   1 keeps `unit` as a deferred slot since the OpenCage template doesn't have a clean rendering
 *   for it). Operators wanting a different join policy can subclass the factory.
 *
 *   Column names below match the canonical SAMHSA Behavioral Health Treatment Services Locator CSV
 *   export header. Operators substituting a closely-related extract should rename columns to match;
 *   the README has the mapping cheatsheet.
 *
 *   License: stamped `"Public Domain"` per the SAMHSA Open Data Foundry's federal-government
 *   distribution terms.
 */

import { createReadStream } from "node:fs"

import { parse as csvParse } from "csv-parse"

import { stableSourceID } from "../../adapter.ts"
import { lookupStateAbbreviation } from "../../codex/us-fips-state.ts"
import { reconcileComponents } from "../../format.ts"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.ts"

export const USGOV_SAMHSA_ADAPTER_ID = "usgov-samhsa-treatment-locator"
export const USGOV_SAMHSA_DEFAULT_LICENSE = "Public Domain"

/**
 * Subset of SAMHSA Treatment Locator CSV columns consulted by the adapter. Column names match the canonical SAMHSA Open
 * Data Foundry export header. `name1` is the venue; `name2` is optional and folded into the venue when present.
 */
interface SamhsaSiteRow {
	name1: string
	name2?: string
	street1: string
	street2?: string
	city: string
	state: string
	zip: string
	/** Optional. Falls back to `stableSourceID` derived from components when missing. */
	frid?: string
}

const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/

function splitAddress(address: string): { house_number?: string; street: string } | null {
	const trimmed = address.trim()

	if (!trimmed) return null
	const m = HOUSE_NUMBER_PREFIX.exec(trimmed)

	if (m) return { house_number: m[1], street: m[2]!.trim() }

	return { street: trimmed }
}

/**
 * Join the SAMHSA two-line street: primary street + optional secondary line (suite / unit / floor / "behind main
 * building") on `", "`. The combined value is the `street` component surface form. Phase 1 does not break this out into
 * the `unit` component — see the file-level comment.
 */
function joinTwoLineStreet(street1: string, street2: string | undefined): string {
	const s1 = street1.trim()
	const s2 = (street2 ?? "").trim()

	if (!s1 && !s2) return ""

	if (!s2) return s1

	if (!s1) return s2

	return `${s1}, ${s2}`
}

/**
 * Combine `name1` + optional `name2` into a single venue surface form. SAMHSA conventions:
 *
 * - `name1` is the program / clinic name ("Mountain Plains Counseling Services").
 * - `name2` is the parent organization ("Catholic Charities of Wyoming"), if any.
 *
 * Both render together as `"<name1> - <name2>"` when both are present — geocoder users typically type either form, so
 * the model benefits from the joined surface.
 */
function composeVenue(name1: string, name2: string | undefined): string {
	const n1 = name1.trim()
	const n2 = (name2 ?? "").trim()

	if (!n1 && !n2) return ""

	if (!n2) return n1

	if (!n1) return n2

	return `${n1} - ${n2}`
}

/** Same envelope-style format as HRSA: venue prefix, street body, city/state/zip suffix. */
function composeRaw(
	venue: string,
	house: string | undefined,
	street: string,
	city: string,
	state: string,
	postcode: string
): string {
	const streetPart = [house, street].filter(Boolean).join(" ").trim()
	const cityPart = [city.trim(), [state, postcode].filter(Boolean).join(" ").trim()].filter(Boolean).join(", ")

	return [venue.trim(), streetPart, cityPart].filter(Boolean).join(", ")
}

export function createUsgovSamhsaTreatmentLocatorAdapter(): CorpusAdapter {
	return {
		id: USGOV_SAMHSA_ADAPTER_ID,
		defaultLicense: USGOV_SAMHSA_DEFAULT_LICENSE,
		description:
			"SAMHSA Behavioral Health Treatment Services Locator (public-domain). Adversarial source: venue + two-line address co-occurrence, hand-entered.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-samhsa adapter: only US supported, got country=${opts.country}`)
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
				for await (const record of parser as AsyncIterable<SamhsaSiteRow>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const venue = composeVenue(record.name1 ?? "", record.name2)
					const street = joinTwoLineStreet(record.street1 ?? "", record.street2)
					const split = splitAddress(street)
					const city = (record.city ?? "").trim()
					const stateAbbr = (record.state ?? "").trim()
					const postcode = (record.zip ?? "").trim()

					if (!venue || !split || !city || !postcode) continue
					const state = lookupStateAbbreviation(stateAbbr)

					if (!state) continue

					// venue first — same kryptonite-defending insertion order as HRSA.
					const components: CanonicalRow["components"] = {
						venue,
						...(split.house_number ? { house_number: split.house_number } : {}),
						street: split.street,
						locality: city,
						region: state.abbreviation,
						postcode,
					}

					const raw = composeRaw(venue, split.house_number, split.street, city, state.abbreviation, postcode)

					if (!raw) continue

					const aligned = reconcileComponents(components, raw)

					if (Object.keys(aligned).length === 0) continue

					const frID = (record.frid ?? "").trim()
					const sourceID = frID
						? `${USGOV_SAMHSA_ADAPTER_ID}-${frID}`
						: stableSourceID(USGOV_SAMHSA_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: USGOV_SAMHSA_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: USGOV_SAMHSA_DEFAULT_LICENSE,
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const usgovSamhsaTreatmentLocatorAdapter = createUsgovSamhsaTreatmentLocatorAdapter()
