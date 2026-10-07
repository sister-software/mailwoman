/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `ads`: Estonia's INSPIRE Addresses (AD) theme, published by Maa- ja Ruumiamet out of the
 * Aadressiandmete süsteem.
 *
 * Input is newline-delimited GeoJSON: one `AD_Address:AD.Address` feature per line, as the service's
 * `outputFormat=application/json` writes them. A page of the service is a `FeatureCollection`, and the
 * acquisition step appends each page's `features` to the file, so the adapter streams a 729,973-feature
 * extract without holding a page in memory.
 *
 * GeoServer flattens the INSPIRE application schema here, so every component value arrives inline on
 * the feature's `properties` and the adapter resolves no reference. The county, the municipality, the
 * settlement unit, the address area, the thoroughfare and the postal descriptor each occupy one of six
 * fixed `component<n>_xlink_title` slots. An unused slot holds the string `unpopulated` rather than a
 * void object. The slot a value lands in is fixed: slot 1 holds the county, slot 2 the municipality,
 * slot 3 the settlement unit, slot 4 the address area, slot 5 the thoroughfare and slot 6 the postal
 * descriptor.
 *
 * The field whose name matches the INSPIRE designator holds an internal ADS code, and the house
 * number sits in the locator's name-spelling element. Estonia writes that ADS code in
 * `locator_addresslocator_designator_locatordesignator_designator` (`7_1DOW`, `7_3P4Y`, `6_0MU3`).
 * The human-readable number is in `locator_addresslocator_name_locatorname_name_spelling_text`. The
 * designator's own type states `addressNumber` on the street rows, so that field is tempting to
 * read. A reader that takes it would stamp `7_1DOW` as the house number on every row.
 *
 * The locator name takes one of two roles, and the feature's structure decides which. A feature that
 * holds a thoroughfare or an address area writes its number there, and one that holds neither writes
 * the farm or building name that designates the addressable unit. The two never co-occur. The adapter
 * therefore reads `house_number` where a thoroughfare element exists and `venue` where none does, so a
 * farm name never arrives labeled as a number.
 *
 * Slots 4 and 5 hold a malformed `href`: it addresses the `AU_haldusyksused` workspace with an
 * `AD_Address` type and answers HTTP 400 `Unknown namespace [AD_Address]`. The adapter reads the slot's
 * `title` and never follows an `href`.
 *
 * A row with no thoroughfare element is the ordinary rural case rather than a defect.
 *
 * Maa- ja Ruumiamet's dataset record states Creative Commons CC0 1.0 in `otherConstraints`. The
 * address-source register elected that license and records it under `spdx` as `CC0-1.0`. CC0 reserves no act, so the
 * adapter stamps that label on every row and the model card needs no attribution clause, although
 * crediting the publisher stays good practice.
 *
 * The adapter honors `opts.limit` and `opts.signal`. `opts.country` is optional and accepts only `EE`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { JSONSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const ADS_ADAPTER_ID = "ads"

/**
 * The one jurisdiction this adapter emits.
 *
 * The service covers Estonia whole, so the set has one member and `opts.country` either
 * matches `EE` or asks for a jurisdiction the dataset does not publish.
 */
export const ADS_COUNTRIES: readonly string[] = ["EE"]

/**
 * The license the address-source register elected for this publisher.
 *
 * `unchecked-access-free-ee-maa-ja-ruumiamet` is elected with `spdx` `CC0-1.0`,
 * from the `otherConstraints` of CSW record `b0bd266e-b4c6-45db-b7ea-f47486b6258b`.
 */
export const ADS_DEFAULT_LICENSE = "CC0-1.0"

/**
 * The sentinel Estonia writes in an unused component slot.
 *
 * It is the local name of an INSPIRE void reason, written as bare text where GeoServer would
 * otherwise write a void object, and it appears in both the slot's `href` and its `title`.
 * A reader that takes the title at face value stores the word as a street name.
 */
const UNPOPULATED = "unpopulated"

/**
 * The flattened `AD.Address` properties this adapter consults.
 *
 * The explicit shape catches a rename early, and leaving the designator out of
 * it is deliberate: the property exists on every feature and holds an ADS code
 * rather than a house number, so the adapter cannot read it by accident.
 */
interface ADSProperties {
	gml_id?: number | string
	inspireid_identifier_localid?: number | string
	locator_addresslocator_name_locatorname_name_spelling_text?: string
	component1_xlink_title?: string
	component2_xlink_title?: string
	component3_xlink_title?: string
	component4_xlink_title?: string
	component5_xlink_title?: string
	component6_xlink_title?: string
}

/**
 * One line of the input: a GeoJSON feature as the service's JSON writer emits it.
 */
interface ADSFeature {
	id?: string
	properties?: ADSProperties
}

/**
 * A component slot's value, or an empty string where the slot is unused.
 *
 * The sentinel is compared case-insensitively because it renders an INSPIRE codelist term
 * rather than a value the publisher authored.
 */
function slotValue(value: string | undefined): string {
	const trimmed = (value ?? "").trim()

	return trimmed.toLowerCase() === UNPOPULATED ? "" : trimmed
}

/**
 * The thoroughfare element a feature addresses, or an empty string where it addresses none.
 *
 * A thoroughfare name and an address area never co-occur on one feature, and the
 * publisher's own `alternativeidentifier` writes either one in the same position:
 * `Veskimäe tee 8` for the first and `Vahatu vkt 19` for the second.
 * The address area is therefore read as the street it stands in for rather than as a separate rung.
 */
export function thoroughfareOf(properties: ADSProperties): string {
	return slotValue(properties.component5_xlink_title) || slotValue(properties.component4_xlink_title)
}

export function createADSAdapter(): CorpusAdapter {
	return {
		id: ADS_ADAPTER_ID,
		defaultLicense: ADS_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.EstoniaADS,
		surface: SurfaceOrigin.Rendered,
		description:
			"Estonia's INSPIRE Addresses theme (Maa- ja Ruumiamet): address points with a thoroughfare or a named site.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !ADS_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(ADS_ADAPTER_ID, ADS_COUNTRIES, opts.country)
			}

			const features = JSONSpliterator.fromAsync<ADSFeature>(opts.inputPath)

			let emitted = 0

			for await (const feature of features) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const properties = feature.properties ?? {}

				const region = slotValue(properties.component1_xlink_title)
				const municipality = slotValue(properties.component2_xlink_title)
				const settlement = slotValue(properties.component3_xlink_title)
				const street = thoroughfareOf(properties)
				const postcode = slotValue(properties.component6_xlink_title)
				const locatorName = (properties.locator_addresslocator_name_locatorname_name_spelling_text ?? "").trim()

				if (!municipality) continue

				if (!postcode && !settlement) continue

				const components: CanonicalRow["components"] = {}

				if (street) {
					// A thoroughfare or an address area makes the locator name this feature's
					// number on that thoroughfare.
					if (locatorName) {
						components.house_number = locatorName
					}

					components.street = street
				} else if (locatorName) {
					// With no thoroughfare the locator name is the site or building name
					// that designates the addressable unit.
					// That is how a rural Estonian address works.
					components.venue = locatorName
				}

				// The settlement unit sits inside the municipality, and Estonia writes it between
				// the thoroughfare and the municipality in its own `alternativeidentifier`.
				if (settlement) {
					components.dependent_locality = settlement
				}

				if (postcode) {
					components.postcode = postcode
				}

				components.locality = municipality

				if (region) {
					components.region = region
				}

				const rendered = formatAddressRow(components, "EE", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				const seed = String(properties.inspireid_identifier_localid ?? properties.gml_id ?? feature.id ?? "").trim()

				const sourceID = seed ? `${ADS_ADAPTER_ID}-${seed}` : stableSourceID(ADS_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "EE",
					locale: "et-EE",
					source: ADS_ADAPTER_ID,
					source_id: sourceID,
					corpus_version: "",
					license: ADS_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const adsAdapter = createADSAdapter()
