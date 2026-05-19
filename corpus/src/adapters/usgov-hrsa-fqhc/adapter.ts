/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-hrsa-fqhc`: HRSA "Health Center Service Delivery Site Locations" CSV consumer.
 *
 *   Federally Qualified Health Centers (FQHCs) are HRSA-funded community health programs that
 *   self-report site addresses to the HRSA Data Warehouse. The published CSV (`data.hrsa.gov`)
 *   carries the site name, the postal-formatted street address, and the locality/region/postcode
 *   quad. Phase 1.6 §1.2 (#22) selects this source for its adversarial-value-per-row: every
 *   facility name is a human-typed venue string and the addresses pass through enough hands to
 *   accumulate the abbreviation drift + suite designator chaos that pure gazetteer data does not.
 *
 *   The adapter consumes a CSV file the operator pre-downloads. The HRSA data is published as a
 *   single national CSV (~10K rows), small enough that the operator can re-fetch on every corpus
 *   rebuild without an intermediate SQLite step. Column names below match the HRSA Data Warehouse's
 *   "Health Center Service Delivery Site" public dataset. Operators substituting the
 *   closely-related "Site Address" or "Health Center" public extracts may need to remap columns;
 *   the README documents the expected set.
 *
 *   Output: one row per CSV record, with `venue` component carrying the site name and the address
 *   quad on `(house_number, street, locality, region, postcode)`. Component order is load-bearing:
 *   `venue` is inserted FIRST so alignment claims its surface span before `locality` searches for
 *   its own (the kryptonite case "Buffalo Health Clinic, …, Buffalo, NY" relies on `venue`
 *   consuming the first "Buffalo" so locality lands on the second).
 *
 *   License: stamped `"Public Domain"` per the HRSA Data Warehouse's federal government distribution
 *   terms.
 */

import { parse as csvParse } from "csv-parse"
import { createReadStream } from "node:fs"
import { stableSourceId } from "../../adapter.js"
import { lookupStateAbbreviation } from "../../codex/us-fips-state.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const USGOV_HRSA_FQHC_ADAPTER_ID = "usgov-hrsa-fqhc"
export const USGOV_HRSA_FQHC_DEFAULT_LICENSE = "Public Domain"

/**
 * Subset of HRSA "Health Center Service Delivery Site Locations" CSV columns consulted by the
 * adapter. Column names match the canonical HRSA Data Warehouse export header. Operators
 * substituting a closely-related extract should rename columns to match; the README has the mapping
 * cheatsheet.
 */
interface HrsaSiteRow {
	"Site Name": string
	"Site Address": string
	"Site City": string
	"Site State Abbreviation": string
	"Site Postal Code": string
	/** Optional. Falls back to `stableSourceId` derived from components when missing. */
	"Site ID"?: string
}

/**
 * Split a "123 Main St Suite 4" surface form into `(house_number, street)`. The regex tolerates one
 * trailing letter on the number (`"123A Main St"`) and a hyphenated form (`"40-12 Bell Blvd"`);
 * anything else falls back to street-only.
 *
 * Suite / Apt / Unit designators stay on `street` for Phase 1 — Mailwoman's `unit` component exists
 * but the address-formatter does not have a clean slot for it, and HRSA addresses do not separate
 * the suite into its own column. Leaving the surface form intact in `street` preserves the
 * adversarial training signal (the model learns that a trailing "Suite 4" is part of the road line
 * in this distribution).
 */
const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/

function splitAddress(address: string): { house_number?: string; street: string } | null {
	const trimmed = address.trim()
	if (!trimmed) return null
	const m = HOUSE_NUMBER_PREFIX.exec(trimmed)
	if (m) return { house_number: m[1], street: m[2]!.trim() }
	return { street: trimmed }
}

/**
 * Compose the raw envelope-style address line. Format:
 *
 * "<Site Name>, <house> <street>, <city>, <state> <postcode>"
 *
 * The site name leads (US conventional addressee-then-address ordering) so a downstream model sees
 * the venue-prefix-then-address shape that HRSA users actually type into geocoders.
 */
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

export function createUsgovHrsaFqhcAdapter(): CorpusAdapter {
	return {
		id: USGOV_HRSA_FQHC_ADAPTER_ID,
		defaultLicense: USGOV_HRSA_FQHC_DEFAULT_LICENSE,
		description:
			"HRSA Federally Qualified Health Center site locations (public-domain). Adversarial source: venue + address co-occurrence, hand-entered.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-hrsa-fqhc adapter: only US supported, got country=${opts.country}`)
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
				for await (const record of parser as AsyncIterable<HrsaSiteRow>) {
					if (opts.signal?.aborted) break
					if (opts.limit !== undefined && emitted >= opts.limit) break

					const venue = (record["Site Name"] ?? "").trim()
					const split = splitAddress(record["Site Address"] ?? "")
					const city = (record["Site City"] ?? "").trim()
					const stateAbbr = (record["Site State Abbreviation"] ?? "").trim()
					const postcode = (record["Site Postal Code"] ?? "").trim()

					if (!venue || !split || !city || !postcode) continue
					const state = lookupStateAbbreviation(stateAbbr)
					if (!state) continue

					// Insertion order matters here. `venue` first so alignment claims its span
					// (which may contain a token like "Buffalo") before `locality` runs its
					// search — the kryptonite case `Buffalo Health Clinic, Buffalo NY`
					// otherwise mis-labels the venue's "Buffalo" as locality.
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

					const siteId = (record["Site ID"] ?? "").trim()
					const sourceId = siteId
						? `${USGOV_HRSA_FQHC_ADAPTER_ID}-${siteId}`
						: stableSourceId(USGOV_HRSA_FQHC_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: USGOV_HRSA_FQHC_ADAPTER_ID,
						source_id: sourceId,
						corpus_version: "",
						license: USGOV_HRSA_FQHC_DEFAULT_LICENSE,
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const usgovHrsaFqhcAdapter = createUsgovHrsaFqhcAdapter()
