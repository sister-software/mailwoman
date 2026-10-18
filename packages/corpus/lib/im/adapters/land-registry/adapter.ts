/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `landregistry-im`: the property addresses of the Isle of Man Land Registry's land transactions, which the
 * Isle of Man Government publishes on gov.im as one CSV of every registered sale since 2000.
 *
 * Each row is a sale, so one property appears once per sale. The adapter emits each distinct address
 * once, comparing the emitted components case-folded and keeping the first. It reads only the address
 * columns and never the price or date columns.
 *
 * `SubUnit_Name` is the flat or apartment (`Flat 2`, `Apartment 5`), `House_Number` the door number,
 * `House_Name` the house's given name (`Ballacain Farm`) or the building's (`Spectrum Apartments`),
 * `Street_Name` the street, `Locality` the estate or village inside the town, and `Town` the post town.
 * The IM layout prints no region, so `Parish_` is not read.
 *
 * The register also records sales of land that has no postal address. Such a row describes the land
 * (`Field North Of Ballawhannel Farm`, `Parcel Of Land`, `Land Adjacent To Mostyn Ville`) in place of
 * naming a property, and the adapter refuses it, as it refuses a garage, a parking space or a substation
 * sold on its own.
 *
 * The Isle of Man Government publishes the dataset under the Isle of Man Open Government Licence, which
 * requires the attribution statement below. Every row records that license.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { acceptPostcode } from "@mailwoman/postcode/country-formats"
import { resolvePath } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceIDFromParts } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import {
	AddressRole,
	type AdapterOptions,
	type CanonicalRow,
	type CorpusAdapter,
	countDropped,
	SurfaceOrigin,
} from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits.
 */
export const LANDREGISTRY_IM_ADAPTER_ID = "landregistry-im"

/**
 * The Isle of Man Open Government Licence, whose version the dataset page does not state.
 * It has no SPDX identifier.
 */
export const LANDREGISTRY_IM_LICENSE = "LicenseRef-IM-OGL"

/**
 * The attribution statement the license requires.
 */
export const LANDREGISTRY_IM_ATTRIBUTION =
	"Contains public sector information licensed under the Isle of Man Open Government Licence"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const LANDREGISTRY_IM_COUNTRIES: readonly string[] = ["IM"]

/**
 * The address columns the adapter reads from the land transactions CSV.
 * The price and date columns are not read.
 */
export interface IsleOfManLandTransactionRecord {
	SubUnit_Name: string
	House_Number: string
	House_Name: string
	Street_Name: string
	Locality: string
	Town: string
	Postcode: string
}

function present(value: string | undefined): string | null {
	const trimmed = value?.replaceAll(/\s+/gu, " ").trim() ?? ""

	return trimmed || null
}

/**
 * A value that describes a piece of land rather than naming a property: it opens with the kind
 * of land (`Land`, `Plot Of Land`, `Field Number 111277`, `Part Of The Estate`, `25.2 Acres Of Land`)
 * or places it against another property (`Abutting`, `Adjacent To`, `Rear Of`, `Known As`).
 */
const LAND_DESCRIPTION =
	/^(?:(?:a|the)\s+)?(?:lands?|plots?|parcels?|fields?|part|strip|portion|[\d.]+\s+acres?)\b|\b(?:abutting|adjacent|adjoining|adjoins|rear\s+off?|part\s+of|known\s+as|formerly|situate|being\s+part|close\s+to|near|nr)\b/iu

/**
 * In a flat or house name, a land word anywhere marks a description
 * (`Riverside Cottage And Land`, `Two Fields At`, `Agricultural Land`),
 * where in a street or locality it may be part of the name.
 */
const LAND_WORD = /\b(?:lands?|fields?|plots?|acres?)\b/iu

/**
 * A value that describes a structure or a share sold apart from any dwelling,
 * which has no postal address of its own.
 */
const NOT_A_PREMISE =
	/^(?:(?:a|the)\s+)?(?:garages?|lock[- ]?ups?|stores?|car\s+park(?:ing)?|forecourt|roadway|access\s+roads?|lane)\b|\b(?:site|substation|reservoir|parking|driveway|pumping\s+station|private\s+(?:roadway|road|drive|lane|access)|(?:common|shared|landscaped)\s+areas?|share\s+(?:in|of))\b/iu

/**
 * A house name that joins two properties (`Gorse Cottage And Willow Cottage`, `"Hawarden" And "Far End"`)
 * records a sale of several premises at once.
 */
const SEVERAL_PROPERTIES = /\band\b|&/iu

/**
 * A house name that opens with a door number (`15 Godred Court`) holds a number
 * and a secondary street rather than a property name.
 */
const LEADING_NUMBER = /^\d/u

/**
 * The flat designators `SubUnit_Name` holds that a single dwelling is written with.
 */
const UNIT_DESIGNATOR =
	/^(?:(?:flat|apartment|apt\.?|unit|penthouse|suite|studio|maisonette)\s*[A-Z]?\d+[A-Z]?|(?:garden|basement|ground\s+floor|first\s+floor|top\s+floor|upper|lower)\s+(?:flat|apartment))$/iu

/**
 * A door number, with an optional letter, or a range of two.
 */
const HOUSE_NUMBER = /^\d+[A-Z]?(?:\s*-\s*\d+[A-Z]?)?$/iu

/**
 * A second-line value that is a thoroughfare (`Main Road`, `Off Clifton Drive`) rather than a place.
 */
const THOROUGHFARE =
	/^off\b|\b(?:road|street|lane|avenue|drive|promenade|terrace|crescent|quay|way|close|parade|square)$/iu

/**
 * Maps one record onto the components the corpus asserts, or returns null when the row is refused.
 *
 * Each refusal and each dropped component increments its reason in `dropped`.
 */
export function componentsForIsleOfManLandTransactionRecord(
	record: IsleOfManLandTransactionRecord,
	dropped?: Pick<AdapterOptions, "dropped">
): CanonicalRow["components"] | null {
	const tally = dropped ?? {}
	const subunit = present(record.SubUnit_Name)
	const name = present(record.House_Name)
	const street = present(record.Street_Name)
	const dependent = present(record.Locality)

	if (
		[subunit, name, street, dependent].some((value) => value && LAND_DESCRIPTION.test(value)) ||
		[subunit, name].some((value) => value && LAND_WORD.test(value))
	) {
		countDropped(tally, "row:land-parcel-description")

		return null
	}

	if ([subunit, name].some((value) => value && NOT_A_PREMISE.test(value))) {
		countDropped(tally, "row:not-a-premise")

		return null
	}

	if (name && SEVERAL_PROPERTIES.test(name)) {
		countDropped(tally, "row:several-properties")

		return null
	}

	if (!street) {
		countDropped(tally, "row:no-street")

		return null
	}

	const components: CanonicalRow["components"] = { street }
	const number = present(record.House_Number)

	if (number && HOUSE_NUMBER.test(number)) {
		components.house_number = number.replaceAll(/\s*-\s*/gu, "-")
	} else if (number) {
		// `9/11`, `3 & 5` and `Unit 4` name several doors or a unit rather than one door number.
		countDropped(tally, "component:house_number:not-one-number")
	}

	if (subunit && UNIT_DESIGNATOR.test(subunit)) {
		components.unit = subunit
	} else if (subunit) {
		// `Apartment 4 and Garage 4` and a bare `7` do not name one dwelling the layout can print.
		countDropped(tally, "component:unit:not-a-unit-designator")
	}

	if (name && UNIT_DESIGNATOR.test(name)) {
		// A flat recorded in the house-name column (`Apartment 9`) is the unit when the unit column is empty.
		if (components.unit) {
			countDropped(tally, "component:venue:unit-designator")
		} else {
			components.unit = name
		}
	} else if (name && LEADING_NUMBER.test(name)) {
		countDropped(tally, "component:venue:holds-a-number")
	} else if (name && /\p{L}{3}/u.test(name)) {
		components.venue = name
	} else if (name) {
		countDropped(tally, "component:venue:code")
	}

	if (!components.house_number && !components.venue) {
		countDropped(tally, "row:no-house-number-or-name")

		return null
	}

	const town = present(record.Town)

	if (town) {
		components.locality = town
	}

	if (dependent && THOROUGHFARE.test(dependent)) {
		countDropped(tally, "component:dependent_locality:thoroughfare")
	} else if (dependent && dependent.toLowerCase() === town?.toLowerCase()) {
		countDropped(tally, "component:dependent_locality:repeats-locality")
	} else if (dependent) {
		components.dependent_locality = dependent
	}

	const postcode = present(record.Postcode)?.toUpperCase()
	const matched = postcode ? acceptPostcode(postcode, "IM") : null

	if (matched) {
		components.postcode = matched
	} else if (postcode) {
		countDropped(tally, "component:postcode:not-country-format")
	}

	if (!components.locality && !components.postcode) {
		countDropped(tally, "row:no-locality-or-postcode")

		return null
	}

	return components
}

/**
 * The case-folded key two sales of one property share.
 */
function addressKey(components: CanonicalRow["components"]): string {
	return Object.keys(components)
		.toSorted()
		.map((tag) => `${tag}=${components[tag as keyof typeof components]?.toLowerCase() ?? ""}`)
		.join("\u001F")
}

export function createIsleOfManLandRegistryAdapter(): CorpusAdapter {
	return {
		id: LANDREGISTRY_IM_ADAPTER_ID,
		defaultLicense: LANDREGISTRY_IM_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.IsleOfManLandTransactions,
		surface: SurfaceOrigin.Rendered,
		description: "Isle of Man Land Registry land transactions (gov.im): the addresses of registered property sales.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !LANDREGISTRY_IM_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(LANDREGISTRY_IM_ADAPTER_ID, LANDREGISTRY_IM_COUNTRIES, opts.country)
			}

			// The file is 4 MB, so it is decoded whole.
			// The BOM would otherwise prefix the first header.
			const text = (await readLocalBuffer(resolvePath(opts.inputPath))).toString("utf8").replace(/^﻿/u, "")

			const records = CSVSpliterator.from<IsleOfManLandTransactionRecord>(Buffer.from(text, "utf8"), {
				normalizeKeys: false,
			})

			const seen = new Set<string>()
			let emitted = 0

			for (const record of records) {
				if (opts.signal?.aborted) return

				if (opts.limit !== undefined && emitted >= opts.limit) return

				const components = componentsForIsleOfManLandTransactionRecord(record, opts)

				if (!components) continue

				const key = addressKey(components)

				if (seen.has(key)) {
					countDropped(opts, "row:repeat-sale")

					continue
				}

				seen.add(key)

				const rendered = formatAddressRow(components, "IM", { singleLine: true })

				if (!rendered) {
					countDropped(opts, "row:render-failed")

					continue
				}

				for (const tag of rendered.unplaced) {
					countDropped(opts, `component:${tag}:not-rendered`)
				}

				const { raw, components: aligned } = rendered

				yield {
					raw,
					components: aligned,
					country: "IM",
					locale: "en-IM",
					source: LANDREGISTRY_IM_ADAPTER_ID,
					// The file carries no record id or coordinates, and the dedupe above leaves
					// one row per distinct address, so the components identify the row.
					source_id: stableSourceIDFromParts(LANDREGISTRY_IM_ADAPTER_ID, aligned),
					corpus_version: "",
					license: LANDREGISTRY_IM_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const isleOfManLandRegistryAdapter = createIsleOfManLandRegistryAdapter()
