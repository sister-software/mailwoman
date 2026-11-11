/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-usgs-post-offices`: the post offices in the USGS National Map structures layer.
 *
 *   The National Structures Dataset's layer 38 holds the United States Postal Service facilities
 *   (feature code 78006) across the states and the five primary territories. Each feature holds a
 *   permanent identifier, the facility's name, its street address, city, state and ZIP Code, and a
 *   point. `mailwoman corpus fetch usgs-post-offices` writes one GeoJSON feature per line, with the
 *   ZIP Code as a string whose leading zeros are intact.
 *
 *   Each row is the facility's name as a venue followed by its address, the same venue-plus-address
 *   shape as `usgov-hrsa-fqhc`. `venue` is inserted first so alignment claims its span before
 *   `locality` searches for its own: "Palm Bay West Post Office, …, Palm Bay, FL" holds the
 *   locality's words inside the venue.
 *
 *   License: a work of the United States Government, public domain under 17 U.S.C. § 105. The
 *   service describes the layer as "public domain structures data".
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { JSONSpliterator } from "spliterator"

import { createUnitSplitter } from "#adapters/street/unit"
import { SourceRegister } from "#registers"
import { streetIndexOpener } from "#street-index/reader"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { lookupStateAbbreviation } from "#us/fips-state"
import { splitUSStreetLine } from "#us/street-unit"

/**
 * Registry id for this adapter, and the source directory its fetcher writes.
 */
export const USGOV_USGS_POST_OFFICES_ADAPTER_ID = "usgov-usgs-post-offices"

/**
 * License stamped on each row: a US federal work, public domain under 17 U.S.C. § 105.
 */
export const USGOV_USGS_POST_OFFICES_DEFAULT_LICENSE = "Public Domain"

/**
 * The file the fetcher writes and the adapter reads, one GeoJSON feature per line.
 */
export const USGS_POST_OFFICES_FILENAME = "post-offices.geojsonl"

/**
 * The properties of one post office as the fetcher writes them.
 *
 * Keys are the service's field names in lower case.
 * A field the service left empty is `null`.
 */
export interface USGSPostOfficeProperties {
	permanent_identifier: string | null
	name: string | null
	address: string | null
	city: string | null
	state: string | null
	/**
	 * A five-digit ZIP Code or ZIP+4 with its leading zeros, or `null` when the published value isn't one.
	 */
	zipcode: string | null
	/**
	 * The value the service published, present only when it differs from `zipcode`.
	 */
	zipcode_published?: string
}

/**
 * One post office as the fetcher writes it.
 */
export interface USGSPostOfficeFeature {
	type: "Feature"
	geometry: { type: "Point"; coordinates: [longitude: number, latitude: number] } | null
	properties: USGSPostOfficeProperties
}

/**
 * Creates the post-office adapter.
 *
 * A post office with no street address or no ZIP Code yields no row, because the
 * row's purpose is the venue beside a full address.
 * `splitUSStreetLine` moves a trailing suite into `unit` when the remainder still reads as a street:
 * by a street-type word, a number, or the street index scoped to the row's city and ZIP Code.
 */
export function createUSGovUSGSPostOfficesAdapter(): CorpusAdapter {
	return {
		id: USGOV_USGS_POST_OFFICES_ADAPTER_ID,
		defaultLicense: USGOV_USGS_POST_OFFICES_DEFAULT_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.USGSPostOffices,
		surface: SurfaceOrigin.Rendered,
		description:
			"USGS National Map post offices (public domain). Venue + address co-occurrence for every USPS facility the structures layer holds.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`${USGOV_USGS_POST_OFFICES_ADAPTER_ID} adapter: only US supported, got country=${opts.country}`)
			}

			const units = await createUnitSplitter({ streetIndex: streetIndexOpener(opts.streetIndex) })

			let emitted = 0

			for await (const feature of JSONSpliterator.fromAsync<USGSPostOfficeFeature>(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const { permanent_identifier: id, name, address, city, state: stateCode, zipcode } = feature.properties
				const place = { ...(city ? { locality: city } : {}), ...(zipcode ? { postcode: zipcode } : {}) }
				const line = address ? splitUSStreetLine(address, units, place) : null
				const state = lookupStateAbbreviation(stateCode)

				if (!id || !name || !line || !city || !state || !zipcode) continue

				// `venue` first, so alignment claims its span before `locality` searches for its own.
				const components: CanonicalRow["components"] = {
					venue: name,
					...line,
					locality: city,
					region: state.abbreviation,
					postcode: zipcode,
				}

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				yield {
					raw: rendered.raw,
					components: rendered.components,
					country: "US",
					locale: "en-US",
					source: USGOV_USGS_POST_OFFICES_ADAPTER_ID,
					source_id: `${USGOV_USGS_POST_OFFICES_ADAPTER_ID}-${id}`,
					license: USGOV_USGS_POST_OFFICES_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const usgovUSGSPostOfficesAdapter = createUSGovUSGSPostOfficesAdapter()
