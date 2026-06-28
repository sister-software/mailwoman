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
 *   rows carry `venue` from the legal business name; individual rows compose `attention` from
 *   last+first name. Address quad goes on `(house_number, street, locality, region, postcode)`.
 *
 *   License: stamped `"Public Domain"` per CMS's federal government distribution terms.
 */

import { createReadStream } from "node:fs"

import { parse as csvParse } from "csv-parse"

import { stableSourceId } from "../../adapter.js"
import { lookupStateAbbreviation } from "../../codex/us-fips-state.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const USGOV_NPPES_ADAPTER_ID = "usgov-nppes"
export const USGOV_NPPES_DEFAULT_LICENSE = "Public Domain"

const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/

interface NppesRow {
	NPI: string
	"Entity Type Code": string
	"Provider Organization Name (Legal Business Name)": string
	"Provider Last Name (Legal Name)": string
	"Provider First Name": string
	"Provider First Line Business Practice Location Address": string
	"Provider Second Line Business Practice Location Address": string
	"Provider Business Practice Location Address City Name": string
	"Provider Business Practice Location Address State Name": string
	"Provider Business Practice Location Address Postal Code": string
}

function splitAddress(address: string): { house_number?: string; street: string } | null {
	const trimmed = address.trim()

	if (!trimmed) return null
	const m = HOUSE_NUMBER_PREFIX.exec(trimmed)

	if (m) return { house_number: m[1], street: m[2]!.trim() }

	return { street: trimmed }
}

function composeRaw(
	venue: string | undefined,
	house: string | undefined,
	street: string,
	city: string,
	state: string,
	postcode: string
): string {
	const streetPart = [house, street].filter(Boolean).join(" ").trim()
	const cityPart = [city.trim(), [state, postcode].filter(Boolean).join(" ").trim()].filter(Boolean).join(", ")

	return [venue, streetPart, cityPart].filter(Boolean).join(", ")
}

export function createUsgovNppesAdapter(): CorpusAdapter {
	return {
		id: USGOV_NPPES_ADAPTER_ID,
		defaultLicense: USGOV_NPPES_DEFAULT_LICENSE,
		description:
			"CMS National Plan and Provider Enumeration System — 7M provider practice locations (public-domain). Venue+address co-occurrence at scale.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-nppes adapter: only US supported, got country=${opts.country}`)
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
				for await (const record of parser as AsyncIterable<NppesRow>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const npi = (record.NPI ?? "").trim()
					const entityType = (record["Entity Type Code"] ?? "").trim()
					const orgName = (record["Provider Organization Name (Legal Business Name)"] ?? "").trim()
					const lastName = (record["Provider Last Name (Legal Name)"] ?? "").trim()
					const firstName = (record["Provider First Name"] ?? "").trim()

					const address1 = (record["Provider First Line Business Practice Location Address"] ?? "").trim()
					const address2 = (record["Provider Second Line Business Practice Location Address"] ?? "").trim()
					const city = (record["Provider Business Practice Location Address City Name"] ?? "").trim()
					const stateRaw = (record["Provider Business Practice Location Address State Name"] ?? "").trim()
					const postcode = (record["Provider Business Practice Location Address Postal Code"] ?? "").trim()

					if (!city || !postcode) continue

					const state = lookupStateAbbreviation(stateRaw)

					if (!state) continue

					const fullStreet = [address1, address2].filter(Boolean).join(" ")
					const split = splitAddress(fullStreet)

					if (!split) continue

					const venue = orgName || [firstName, lastName].filter(Boolean).join(" ") || undefined

					const components: CanonicalRow["components"] = {
						...(venue ? { venue } : {}),
						...(split.house_number ? { house_number: split.house_number } : {}),
						street: split.street,
						locality: city,
						region: state.abbreviation,
						postcode,
					}

					const raw = composeRaw(venue, split.house_number, split.street, city, state.abbreviation, postcode)

					if (!raw) continue

					const aligned = reconcileComponents(components, raw)

					if (Object.keys(aligned).length <= 2) continue

					const sourceId = npi ? `${USGOV_NPPES_ADAPTER_ID}-${npi}` : stableSourceId(USGOV_NPPES_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: USGOV_NPPES_ADAPTER_ID,
						source_id: sourceId,
						corpus_version: "",
						license: USGOV_NPPES_DEFAULT_LICENSE,
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const usgovNppesAdapter = createUsgovNppesAdapter()
