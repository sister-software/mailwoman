/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `adressur-fo`: the Faroese national address register, `Adressur`, which Umhvørvisstovan (the Faroese
 * Environment Agency) serves as the ArcGIS MapServer layer `adressur/us_adr_husanr/MapServer/0` on
 * `gis.us.fo`.
 *
 * Input is the layer queried whole as GeoJSON (`query?where=1=1&outFields=*&f=geojson&outSR=4326`), one
 * FeatureCollection, or a directory of such page files read in name order. Each feature's `properties`
 * hold the register's columns. The register states no absent value as a sentinel: `house_letter` is the
 * empty string when a number has no letter, and every row has a street, since Faroese villages name
 * their lanes and paths too (`Heimi í Húsi`, `Suðuri á Bø`).
 *
 * The adapter reads `street_name` as the street, `house_digit` with `house_letter` as the house number
 * (their concatenation equals the register's own `house_no` on every row), `zip` as the postcode and
 * `city` as the postal locality. The values `Nes, Eysturoy` and `Syðradalur, Kalsoy` include commas
 * that disambiguate them. The adapter keeps both values as the register spells them.
 * `municipality` is left out, because the FO layout prints no region.
 *
 * Umhvørvisstovan grants anyone a free, worldwide right to copy, distribute, publish, modify and combine
 * the data, for commercial and non-commercial use, on condition that the source is credited as
 * `Data from the Faroese Environment Agency, Umhvørvisstovan: Adressur, <date>` and the terms are made
 * available to third parties. Every row records those terms.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { parseJSONStrict } from "@mailwoman/core/json"
import { acceptPostcode } from "@mailwoman/postcode/country-formats"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { present } from "#adapters/present"
import { stableSourceIDFromParts } from "#adapters/source-id"
import { composeHouseNumber } from "#adapters/street-line"
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
export const ADRESSUR_FO_ADAPTER_ID = "adressur-fo"

/**
 * Umhvørvisstovan's `Brúksrættur og treytir` (June 2019).
 * They have no SPDX identifier.
 */
export const ADRESSUR_FO_LICENSE = "LicenseRef-FO-Umhvorvisstovan-Brukstreytir"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const ADRESSUR_FO_COUNTRIES: readonly string[] = ["FO"]

/**
 * The feature properties the adapter reads.
 */
export interface AdressurRecord {
	address_id: number | null
	house_digit: number | null
	house_letter: string | null
	street_name: string | null
	zip: number | string | null
	city: string | null
}

interface AdressurFeatureCollection {
	features?: Array<{ properties?: AdressurRecord | null }>
}

/**
 * Maps one record onto the components the corpus asserts, or returns null when the row is refused.
 *
 * Each refusal increments its reason in `dropped`.
 */
export function componentsForAdressurRecord(
	record: AdressurRecord,
	dropped?: Pick<AdapterOptions, "dropped">
): CanonicalRow["components"] | null {
	const tally = dropped ?? {}
	const street = present(record.street_name)

	if (!street) {
		countDropped(tally, "row:no-street")

		return null
	}

	const number = composeHouseNumber(present(record.house_digit) ?? "", present(record.house_letter) ?? "")

	if (!number) {
		countDropped(tally, "row:no-house-number")

		return null
	}

	const components: CanonicalRow["components"] = {
		street,
		house_number: number,
	}

	const postcode = present(record.zip)
	const matched = postcode ? acceptPostcode(postcode, "FO") : null

	if (matched) {
		components.postcode = matched
	} else if (postcode) {
		countDropped(tally, "component:postcode:not-country-format")
	}

	const locality = present(record.city)

	if (locality) {
		components.locality = locality
	}

	if (!components.locality && !components.postcode) {
		countDropped(tally, "row:no-locality-or-postcode")

		return null
	}

	return components
}

/**
 * The GeoJSON files an input names: the file itself, or every `.geojson` in a directory, in name order.
 */
async function pageFiles(inputPath: string): Promise<string[]> {
	const stat = await tryStat(inputPath)

	if (!stat?.isDirectory()) return [inputPath]

	const names = await Globerator.from("*.geojson", {
		cwd: inputPath,
		absolute: false,
	}).toSorted()

	return names.map((name) => `${inputPath}/${name}`)
}

export function createAdressurFaroeAdapter(): CorpusAdapter {
	return {
		id: ADRESSUR_FO_ADAPTER_ID,
		defaultLicense: ADRESSUR_FO_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.FaroeAdressur,
		surface: SurfaceOrigin.Rendered,
		description: "Adressur (Umhvørvisstovan): the national address register of the Faroe Islands.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !ADRESSUR_FO_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(ADRESSUR_FO_ADAPTER_ID, ADRESSUR_FO_COUNTRIES, opts.country)
			}

			let emitted = 0

			for (const file of await pageFiles(resolvePath(opts.inputPath))) {
				// The whole layer is one 20 MB response, so each page is parsed whole.
				const collection = parseJSONStrict<AdressurFeatureCollection>(await readLocalTextFile(file))

				if (!Array.isArray(collection.features)) {
					throw new TypeError(`${ADRESSUR_FO_ADAPTER_ID} adapter: ${file} holds no GeoJSON features array`)
				}

				for (const feature of collection.features) {
					if (opts.signal?.aborted) return

					if (typeof opts.limit === "number" && emitted >= opts.limit) return

					const record = feature.properties

					if (!record) {
						countDropped(opts, "row:no-properties")

						continue
					}

					const components = componentsForAdressurRecord(record, opts)

					if (!components) continue

					const rendered = formatAddressRow(components, "FO", {
						singleLine: true,
					})

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
						country: "FO",
						locale: "fo-FO",
						source: ADRESSUR_FO_ADAPTER_ID,
						// `address_id` is the register's own identifier, unique per feature.
						source_id: stableSourceIDFromParts(ADRESSUR_FO_ADAPTER_ID, {
							...aligned,
							address_id: present(record.address_id) ?? "",
						}),
						corpus_version: "",
						license: ADRESSUR_FO_LICENSE,
					}

					emitted++
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const adressurFaroeAdapter = createAdressurFaroeAdapter()
