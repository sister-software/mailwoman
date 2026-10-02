/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `emuia`: Poland's INSPIRE Addresses (AD) theme, published by Główny Urząd Geodezji i Kartografii out
 * of the Państwowy Rejestr Granic.
 *
 * Input is GML, because the service serves four GML flavours and no JSON. Its capabilities document
 * advertises no `outputFormat` values at all and a `GetFeature` returns
 * `application/gml+xml; version=3.2`. A page is a `wfs:FeatureCollection` of `ms:AD.Address` members,
 * and the adapter reads it with `streamMarkupElements` from `@mailwoman/core/html/elements`, which
 * yields one member subtree at a time, so neither a page nor a whole extract sits in memory.
 *
 * The payload is the Polish register's own schema rather than the harmonised INSPIRE model: a member's
 * element names are the register's columns and every address value is inline, so there is no
 * `ad:ThoroughfareName` to join to and no `xlink:href` to resolve. Read with that same function over
 * 500 members across ten windows spread through the service, a member carries 21 children and never a
 * twenty-second: `gml:boundedBy`, `ms:msGeometry` and nineteen columns, which are `ms:id`,
 * `ms:gml_id`, `ms:lokalnyid`, `ms:jednostkaadmnistracyjna`, `ms:miejscowosc`,
 * `ms:miejscowosc_lower`, `ms:czescmiejscowosci`, `ms:ulica`, `ms:ulica_pol`, `ms:ulica_skr`,
 * `ms:numer`, `ms:kod`, `ms:teryt`, `ms:simc`, `ms:ulic`, `ms:status`, `ms:data_od`, `ms:wazny_od`
 * and `ms:adres`. The adapter reads `ulica` as the street, `numer` as the house number, `kod` as the
 * postcode and `miejscowosc` as the locality, with `czescmiejscowosci` as the part of the locality
 * where the publisher populates it. Every column is written on every member, and three carry a value
 * on every one of the 500: `numer`, `kod` and `miejscowosc`. Two are written and populated on none:
 * `status` and `czescmiejscowosci`.
 *
 * A row with no street is the ordinary rural case rather than a defect. Over those 500 members 299
 * carry a street and 201 leave `ms:ulica` written and empty, and the publisher's own `ms:adres` writes
 * the streetless form as locality and number: `Księżyki 5`, `Jawor 19`. The adapter emits those rows
 * with a locality and a number and no street, which is the address Poland delivers to.
 *
 * `ms:jednostkaadmnistracyjna` carries the administrative path as a PostgreSQL array literal,
 * `{Polska,łódzkie,"Piotrków Trybunalski","Piotrków Trybunalski"}`, whose second element is the
 * voivodeship. It is left unread: a Polish postal address does not carry the voivodeship, the codex
 * layout for `PL` leaves a `region` component unplaced, and parsing a quoted array literal to reach a
 * value the layout leaves unplaced would cost a parse and reach no rendered component.
 *
 * The service states no count of its own. `resultType=hits` answers `numberMatched="1000"`, which is
 * MapServer's default feature cap rather than a count — it stays 1000 when asked with `count=2000` and
 * when asked at `startIndex=1` — and a feature page answers `numberMatched="unknown"`. The size is a
 * property of the service on the day it is asked, so this file states no count. The acquisition
 * step reads it by paging, with `countWFSFeaturesByPaging` from `@mailwoman/core/api`.
 *
 * GUGiK's dataset record states one condition of use, in `otherConstraints`: `Brak warunków dostępu i
 * użytkowania`, no conditions for access and use. The address-source register elected that and names
 * no licence instrument, so no SPDX identifier exists and the publisher's own words are the label the
 * adapter stamps on every row. Crediting GUGiK stays good practice and the statement requires it
 * nowhere.
 *
 * The adapter honors `opts.limit` and `opts.signal`. `opts.country` is optional and accepts only `PL`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { streamMarkupElements, textAtPath, type MarkupElement } from "@mailwoman/core/html/elements"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 * The name is the municipal register the feature ids point at: a `ms:gml_id`
 * reads `PL.ZIPIN.3742.EMUiA_9945001100000172050`.
 */
export const EMUIA_ADAPTER_ID = "emuia"

/**
 * The one jurisdiction this adapter emits.
 */
export const EMUIA_COUNTRIES: readonly string[] = ["PL"]

/**
 * The terms the address-source register elected for this publisher.
 *
 * `unchecked-access-free-pl-g-wny-urz-d-geodezji-i-kartografii` is elected with no `spdx`
 * and no `termsVersion`, so `electedTerms` is the whole of what the publisher stated
 * and `electedLicenseLabel` returns exactly this string.
 * Czechia's row is recorded the same way.
 */
export const EMUIA_DEFAULT_LICENSE = "Brak warunków dostępu i użytkowania"

/**
 * The feature element MapServer writes, spelled as the document spells it.
 *
 * The prefix is the service's own, `ms:`, rather than `ad:`.
 * A reader comparing the part after the colon against `Address` finds no address
 * type here, because the local name is `AD.Address`.
 */
const ADDRESS_ELEMENT = "ms:AD.Address"

/**
 * A member's column value, trimmed, or an empty string.
 *
 * `textAtPath` answers an empty string for an element the publisher wrote
 * and left blank and `undefined` for one it omitted.
 * Both are an absent value for this adapter's purposes, and all 500 members measured carried
 * every one of the nineteen columns, so the distinction carries no information on this service.
 */
function column(feature: MarkupElement, name: string): string {
	return (textAtPath(feature, `ms:${name}`) ?? "").trim()
}

export function createEMUiAAdapter(): CorpusAdapter {
	return {
		id: EMUIA_ADAPTER_ID,
		defaultLicense: EMUIA_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.PolandEMUiA,
		surface: SurfaceOrigin.Rendered,
		description:
			"Poland's INSPIRE Addresses theme (GUGiK): house-number-level addresses from the municipal EMUiA registers.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !EMUIA_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(EMUIA_ADAPTER_ID, EMUIA_COUNTRIES, opts.country)
			}

			const stream = openReadStream(opts.inputPath)

			let emitted = 0

			try {
				for await (const feature of streamMarkupElements(stream, ADDRESS_ELEMENT, {
					xml: true,
					signal: opts.signal,
				})) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const street = column(feature, "ulica")
					const house = column(feature, "numer")
					const postcode = column(feature, "kod")
					const locality = column(feature, "miejscowosc")
					const partOfLocality = column(feature, "czescmiejscowosci")

					if (!locality) continue

					if (!house && !street) continue

					const components: CanonicalRow["components"] = {}

					if (house) {
						components.house_number = house
					}

					if (street) {
						components.street = street
					}

					if (partOfLocality && partOfLocality !== locality) {
						components.dependent_locality = partOfLocality
					}

					if (postcode) {
						components.postcode = postcode
					}

					components.locality = locality

					const rendered = formatAddressRow(components, "PL", { singleLine: true })

					if (!rendered) continue

					const { raw, components: aligned } = rendered

					// `ms:gml_id` names the upstream municipal register and its record, which is
					// the identifier worth keeping; `ms:id` is this service's own row number.
					const seed = column(feature, "gml_id") || column(feature, "id")

					const sourceID = seed ? `${EMUIA_ADAPTER_ID}-${seed}` : stableSourceID(EMUIA_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "PL",
						locale: "pl-PL",
						source: EMUIA_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: EMUIA_DEFAULT_LICENSE,
					}

					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const emuiaAdapter = createEMUiAAdapter()
