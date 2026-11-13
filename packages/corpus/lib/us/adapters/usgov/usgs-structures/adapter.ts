// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `usgov-usgs-structures`: the National Structures Dataset served by the USGS
 *   National Map structures MapServer.
 *
 *   The dataset holds public facilities across the states and the five primary territories:
 *   schools, colleges, hospitals, fire, police and ambulance stations, prisons,
 *   courthouses, town halls, post offices, cemeteries, and recreation sites.
 *   `#us/structures/usgs/layers` lists each point layer.
 *
 *   Each feature holds a permanent identifier, the facility's name, its street address,
 *   city, state and ZIP Code, and a point.
 *
 *   `mailwoman corpus fetch usgs-structures` writes one GeoJSON feature per line,
 *   with the ZIP Code as a string whose leading zeros are intact and the layer it came from.
 *
 *   Each row is the facility's name as a venue followed by its address,
 *   the same venue-plus-address shape as `usgov-hrsa-fqhc`.
 *   `venue` is inserted first so alignment claims its span before `locality` searches for its own:
 *   "Palm Bay West Post Office, …, Palm Bay, FL" holds the locality's words inside the venue.
 *   A layer whose `trains` flag is unset yields no row.
 *
 *   License: a work of the United States Government, public domain under 17 U.S.C. § 105.
 *   The service describes the dataset as "public domain structures data".
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { JSONSpliterator } from "spliterator"

import { createUnitSplitter, type UnitSplitter } from "#adapters/street/unit"
import { SourceRegister } from "#registers"
import { streetIndexOpener } from "#street-index/reader"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { lookupStateAbbreviation } from "#us/fips-state"
import { splitUSStreetLine } from "#us/street-unit"
import { usgsStructureLayer } from "#us/structures/usgs/layers"

/**
 * Registry id for this adapter, and the source directory its fetcher writes.
 */
export const USGOV_USGS_STRUCTURES_ADAPTER_ID = "usgov-usgs-structures"

/**
 * License stamped on each row: a US federal work, public domain under 17 U.S.C. § 105.
 */
export const USGOV_USGS_STRUCTURES_DEFAULT_LICENSE = "Public Domain"

/**
 * The file the fetcher writes and the adapter reads, one GeoJSON feature per line.
 */
export const USGS_STRUCTURES_FILENAME = "structures.geojsonl"

/**
 * The properties of one structure as the fetcher writes them.
 *
 * Keys are the service's field names in lower case, plus `layer_id` and `layer`.
 * A field the service left empty is `null`.
 */
export interface USGSStructureProperties {
	/**
	 * The id of the MapServer layer the feature was read from.
	 */
	layer_id: number
	/**
	 * The layer's slug in `#us/structures/usgs/layers`.
	 */
	layer: string
	/**
	 * The service's `OBJECTID`, unique across the layers.
	 */
	objectid: number
	permanent_identifier: string | null
	fcode: number | null
	gnis_id: string | null
	name: string | null
	addressbuildingname: string | null
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
	/**
	 * The date the publisher loaded the feature, as an ISO 8601 date, or `null` when unstated.
	 */
	loaddate: string | null
	source_originator: string | null
}

/**
 * One structure as the fetcher writes it.
 */
export interface USGSStructureFeature {
	type: "Feature"
	geometry: { type: "Point"; coordinates: [longitude: number, latitude: number] } | null
	properties: USGSStructureProperties
}

/**
 * A structure's address as labeled components, or `null` when it lacks a street address,
 * city, recognized state or ZIP Code.
 *
 * `splitUSStreetLine` moves a trailing suite into `unit` when the remainder still reads as a street:
 * by a street-type word, a number, or the street index scoped to the row's city and ZIP Code.
 */
export function usgsStructureAddress(
	properties: Pick<USGSStructureProperties, "address" | "city" | "state" | "zipcode">,
	units: UnitSplitter
): CanonicalRow["components"] | null {
	const { address, city, state: stateCode, zipcode } = properties
	const place = { ...(city ? { locality: city } : {}), ...(zipcode ? { postcode: zipcode } : {}) }
	const line = address ? splitUSStreetLine(address, units, place) : null
	const state = lookupStateAbbreviation(stateCode)

	if (!line || !city || !state || !zipcode) return null

	return { ...line, locality: city, region: state.abbreviation, postcode: zipcode }
}

/**
 * Creates the structures adapter.
 *
 * A structure in a layer that doesn't train, or with no name or no full address
 * ({@linkcode usgsStructureAddress}), yields no row, because the row's purpose
 * is the venue beside a full address.
 */
export function createUSGovUSGSStructuresAdapter(): CorpusAdapter {
	return {
		id: USGOV_USGS_STRUCTURES_ADAPTER_ID,
		defaultLicense: USGOV_USGS_STRUCTURES_DEFAULT_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.USGSStructures,
		surface: SurfaceOrigin.Rendered,
		description:
			"USGS National Structures Dataset (public domain). Venue + address co-occurrence for the schools, hospitals, emergency stations, government buildings, post offices and cemeteries the National Map holds.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`${USGOV_USGS_STRUCTURES_ADAPTER_ID} adapter: only US supported, got country=${opts.country}`)
			}

			const units = await createUnitSplitter({ streetIndex: streetIndexOpener(opts.streetIndex) })

			let emitted = 0

			for await (const feature of JSONSpliterator.fromAsync<USGSStructureFeature>(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const { permanent_identifier: id, name, layer_id: layerID } = feature.properties

				if (!usgsStructureLayer(layerID).trains) continue

				const address = usgsStructureAddress(feature.properties, units)

				if (!id || !name || !address) continue

				// `venue` first, so alignment claims its span before `locality` searches for its own.
				const components: CanonicalRow["components"] = { venue: name, ...address }

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				yield {
					raw: rendered.raw,
					components: rendered.components,
					country: "US",
					locale: "en-US",
					source: USGOV_USGS_STRUCTURES_ADAPTER_ID,
					source_id: `${USGOV_USGS_STRUCTURES_ADAPTER_ID}-${id}`,
					license: USGOV_USGS_STRUCTURES_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const usgovUSGSStructuresAdapter = createUSGovUSGSStructuresAdapter()
