/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `brussels`: the INSPIRE Addresses (AD) theme the Brussels Regional Informatics Center publishes out
 * of UrbIS.
 *
 * Coverage is the Brussels-Capital Region rather than Belgium. Belgium needs three readers, because
 * each region publishes the theme through its own service: Flanders through a WFS (`vlaanderen`),
 * Wallonia through an ATOM download service (`wallonie`), and Brussels through the bare HTTP
 * download below. Every row this adapter emits is `BE`, and any other `opts.country` raises
 * {@linkcode UnsupportedCountryError}.
 *
 * The schema-level reading is `#inspire/address`. This module holds only what is Brussels' own: the
 * NIS code embedded in every place name, and the empty component reference nine addresses write.
 *
 * ## The publication
 *
 * `https://urbisdownload.datastore.brussels/INSPIRE/URBIS_ADM_Adresses.zip`, HTTP 200, 11,521,182
 * bytes, holding one member `UrbAdm_Adresses.gml` of 474,245,978 bytes. The member is streamed and
 * never buffered.
 *
 * Brussels publishes no INSPIRE ATOM feed for this theme, so there is no `<updated>` to poll and the
 * download is a bare URL. The archive's `last-modified` is `Thu, 01 Dec 2022 07:57:50 GMT`, against
 * Wallonia's 2025-12-11, so this is the older of the two Belgian regional publications by three
 * years.
 *
 * Two of the publisher's hostnames do not serve it. `urbis.brussels` and `urbisonline.brussels` both
 * fail TLS with `ERR_TLS_CERT_ALTNAME_INVALID`, because the certificate's altnames are `*.irisnet.be`
 * and `irisnet.be`. The services live on `irisnet.be`, and the GML's own `base:namespace` states that
 * host: `http://urbisdownload-v2.gis.irisnet.be/en/temporality#`.
 *
 * Counts, read 2026-10-02 with {@linkcode streamMarkupElements} and reconciled against a second
 * instrument that extracted `gml:featureMember` blocks from the same stream as text: 225,660
 * `ad:Address`, 6,238 `ad:ThoroughfareName`, 26 `ad:PostalDescriptor` and 23 `ad:AdminUnitName`. It
 * publishes no `ad:AddressAreaName`. The two instruments agree and they reconcile: 225,660 addresses
 * plus 6,287 component features is the 231,947 `gml:featureMember` elements the file holds, and
 * 231,947 is also the number of void `ad:validFrom` elements, one per member.
 *
 * ## The join takes one pass
 *
 * Brussels writes all 6,287 component features before the first address, the opposite of Wallonia, so
 * one pass indexes and joins. Each address writes exactly 7 `ad:component` references — country,
 * region, province, district, municipality, postal zone and street — all of them local `#` fragments.
 * Of 1,579,620 reference slots, 1,579,611 name a `gml:id` in the same document and every one of those
 * resolves. The remaining 9 are empty.
 *
 * ## The nine empty references
 *
 * Nine addresses write `<ad:component xlink:href=""/>` in the postal-zone slot, so those nine state
 * no postcode: `BE.BRUSSELS.BRIC.ADM.ADPT.220623`, `.220631`, `.220635`, `.256972`, `.257005` and
 * four more, in Bruxelles and Schaerbeek. `componentHrefs` skips an empty href, so an unwary reader
 * yields those rows with the postcode simply missing. This adapter refuses them and
 * counts them under {@link Refusals.noPostcode}, because a postcode the publisher left unstated is
 * not a postcode this repository may read as absent from the address.
 *
 * ## The NIS code embedded in every place name
 *
 * An `ad:AdminUnitName` spells its name as the NIS code, a space, and the name in parentheses:
 * `21019 (Woluwe-Saint-Pierre)`, `21004 (Bruxelles)`, `01000 (Belgique)`,
 * `21000 (Bruxelles-Capitale)`. All 23 take that shape. The code is the publisher's key rather than
 * part of the name, so {@linkcode placeNameWithoutNISCode} strips it and a row reads
 * `Woluwe-Saint-Pierre`. A name not of that shape is returned unchanged rather than guessed at.
 *
 * The province the file names is `20001 (Brabant flamand)`, and the Brussels-Capital Region sits in no
 * province. This adapter reads the province nowhere: the locality comes from the unit at
 * {@link MUNICIPALITY_LEVEL}.
 *
 * ## Voids state no reason at all
 *
 * Not one nil in this file states a `nilReason`. Over the whole member, 0 void elements give a
 * reason and these state none: `ad:validFrom` 231,947, `ad:method` 225,660, `ad:specification`
 * 225,660, `gn:nativeness`, `gn:nameStatus`, `gn:sourceOfName`, `gn:pronunciation` and `gn:script`
 * 12,574 each, `ad:beginLifespanVersion` 23 and `ad:adminUnit` 23. A reader keyed on `nilReason`
 * mistakes every one of them for a populated value. `isVoid` in `#inspire/address` therefore keys
 * on `xsi:nil`, and `voidReason` is read nowhere here.
 *
 * ## Coordinates
 *
 * This adapter emits text and components only, because {@linkcode CanonicalRow} declares no position
 * field. The axis order is recorded here for whoever does emit one, because this publisher
 * contradicts its own declaration.
 *
 * Brussels declares `srsName="http://www.opengis.net/def/crs/EPSG/0/3035"`, whose authority order is
 * northing then easting, and writes easting then northing. `BE.BRUSSELS.BRIC.ADM.ADPT.169731` states
 * `gml:pos` `3928985.14831507 3095401.17112511`. Read in the declared order that is latitude
 * 56.877382, longitude −10.402355, in the Atlantic west of Ireland. Swapped it is latitude 50.835742,
 * longitude 4.429144, in Woluwe-Saint-Pierre, the municipality the same address's own
 * components name. The file's `gml:boundedBy` lower corner, `3916355.39160602 3088216.44803091`, puts
 * the easting first in the same way, and Wallonia's, `2942208.441255148 3816649.462808032`, puts the
 * northing first. So the two Belgian regions declare one CRS and write two axis orders, and a reader
 * that emits coordinates must decide per publisher rather than per declaration.
 *
 * ## Terms, and why no row of this source may ship yet
 *
 * **The address-source register holds no row for Brussels.** Its four `BE` sources are
 * `be-business-legal-1`, `be-business-register-1`, `be-property-building-1` (Flanders) and
 * `be-property-building-2` (Wallonia). The word Brussels appears in the register only inside
 * Flanders' and Wallonia's own prose. Both state that Brussels publishes separately. So no license
 * decision has been elected for this publisher, `electedLicenseLabel` finds no decision to answer
 * with, and {@linkcode BRUSSELS_DEFAULT_LICENSE} is a label that reads as unreviewed rather than an
 * SPDX id that would read as elected.
 *
 * `createIneligibilityReader` refuses every row whose source no register row declares, so this
 * adapter's rows cannot enter a release-profile corpus until a row exists, a license is elected for
 * it, and its `adapterID` is set to `brussels`. Until then the adapter is a reader without a grant.
 *
 * The publisher is reported to state CC BY 4.0 in its GeoNetwork record. This file records that as
 * reported rather than as observed, because the catalogue was not reached from here on 2026-10-02:
 * `datastore.brussels/geonetwork/srv/...` answered HTTP 404 on both the API and CSW paths and
 * `geocatalog.brussels` did not resolve. The register elects the terms, and that election needs the
 * record itself.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { streamMarkupElements } from "@mailwoman/core/html/elements"
import { stringifyJSON } from "@mailwoman/core/json"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import {
	adminUnitLevel,
	componentHrefs,
	componentJoinKey,
	designator,
	designatorsByType,
	placeName,
	postalDescriptorCode,
	thoroughfareName,
	voidDesignatorTypes,
} from "#inspire/address"
import { inspireGMLChunks } from "#inspire/archive"
import { InspireArchiveError } from "#inspire/errors"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 * The name is the region, as `vlaanderen`'s and `wallonie`'s are.
 */
export const BRUSSELS_ADAPTER_ID = "brussels"

/**
 * The stable id of the publication behind every row.
 *
 * It belongs in `SourceRegister` beside `be-vlaanderen-inspire-ad`, and this constant
 * stands in until that entry lands, because a built corpus stores the id on every row
 * and the id must not change afterwards.
 * Replace the constant with the `SourceRegister` member on integration.
 */
export const BRUSSELS_SOURCE_REGISTER = SourceRegister.BrusselsInspireAddresses

/**
 * The one jurisdiction this adapter emits.
 *
 * The download publishes the Brussels-Capital Region, to which ISO 3166-1 assigns
 * no code of its own, so the set holds one code and a caller naming another gets
 * {@linkcode UnsupportedCountryError} rather than zero rows.
 */
export const BRUSSELS_COUNTRIES: readonly string[] = ["BE"]

/**
 * The license label recorded on every row.
 *
 * The register's source `be-property-building-3` elects `CC-BY-4.0` for Paradigm, read from
 * the `gmd:useConstraints` of ISO 19139 record `260abd6f-c5b4-4a79-aa80-d6c265002d65`.
 * That record lists `URBIS_ADM_Adresses.zip` among its distributions and governs this archive
 * rather than Paradigm's other address product, the BeSt Brussels register, licensed CC0-1.0.
 *
 * The value is the SPDX identifier rather than the license's title, because
 * `licenseVerdict` resolves an identifier and reads a title as unrecognized.
 * The constant must not hold a placeholder such as `unreviewed-be-brussels-urbis`.
 *
 * That value resolves to no expression, so these rows would reach a build as unknown obligations.
 */
export const BRUSSELS_DEFAULT_LICENSE = "CC-BY-4.0"

/**
 * The archive member holding the GML.
 *
 * A pattern rather than the literal `UrbAdm_Adresses.gml`, so a republication
 * that renames the member still reads.
 * The archive measured holds exactly one member.
 */
const GML_MEMBER = /\.gml$/iu

/**
 * The designator type Brussels writes its house number under.
 *
 * `buildingIdentifier`, which is Czechia's term, rather than Wallonia's `addressIdentifierGeneral`.
 * One designator of this type sits on all 225,660 addresses and no address writes a second
 * designator of any type, so the number is selected by this term rather than by position.
 */
const HOUSE_NUMBER_DESIGNATOR = "buildingIdentifier"

/**
 * The `ad:level` of the administrative unit that holds the municipality name.
 *
 * An address references five administrative units: the country at `1stOrder`, the region at `2ndOrder`,
 * the province at `3rdOrder`, the district at `4thOrder` and the municipality at `5thOrder`.
 * A reader that took whichever arrived first would write `Belgique` into the `locality` of every row.
 *
 * The nineteen municipalities are the `BE.BRUSSELS.BRIC.ADM.MU.*` features.
 */
const MUNICIPALITY_LEVEL = "5thOrder"

/**
 * The component feature types the first pass indexes.
 *
 * Three rather than four, because this publisher writes no `ad:AddressAreaName`.
 * They are read in one pass, because the publisher writes them interleaved ahead
 * of the addresses rather than grouped by type.
 */
const COMPONENT_TYPES = ["ad:ThoroughfareName", "ad:PostalDescriptor", "ad:AdminUnitName"] as const

/**
 * The number of `ad:component` references an address writes.
 *
 * Exactly 7 on all 225,660 addresses measured: country, region, province,
 * district, municipality, postal zone and street.
 * An address reaching the reader with fewer readable references has written one of them empty.
 *
 * That count is how the nine postcode-less addresses are told apart from an
 * address whose reference simply does not resolve.
 */
const COMPONENTS_PER_ADDRESS = 7

/**
 * The NIS code and the name, as an `ad:AdminUnitName` spells them together.
 *
 * The code is five digits in every one of the 23 features, and the name follows it in parentheses.
 * The pattern anchors both ends, so a name holding its own parentheses cannot
 * be truncated by a partial match.
 */
const NIS_CODED_NAME = /^(\d+)\s*\((.*)\)$/u

/**
/**
 * A place name with the publisher's NIS code removed.
 *
 * `21019 (Woluwe-Saint-Pierre)` reads `Woluwe-Saint-Pierre`.
 * A value not of that shape is returned trimmed and otherwise unchanged, because this strips
 * a prefix the publisher writes rather than parsing a name: a changed shape must reach a
 * reader as the publisher's own value instead of as a guess at what the name inside might be.
 *
 * A value of that shape whose parentheses hold an empty string answers `undefined`,
 * so the caller refuses the row rather than writing a NIS code into a locality.
 *
 * @returns The name, or `undefined` for an absent value and for a code with an empty name.
 */
export function placeNameWithoutNISCode(value: string | undefined): string | undefined {
	const trimmed = value?.trim()

	if (!trimmed) return undefined

	const coded = NIS_CODED_NAME.exec(trimmed)

	if (!coded) return trimmed

	return coded[2]!.trim() || undefined
}

/**
 * The components an address references, keyed by the `gml:id` its `#` fragment names.
 */
export interface BrusselsComponentIndex {
	/**
	 * `ad:ThoroughfareName` → the street name the publisher spells.
	 *
	 * A street writes a French and a Dutch `ad:name`, in that order, and `thoroughfareName`
	 * reads the first: `BE.BRUSSELS.BRIC.ADM.PN.2110` is `Avenue Jules de Trooz`
	 * and `Jules de Troozlaan`, and the row takes the French spelling.
	 */
	streets: ReadonlyMap<string, string>
	/**
	 * `ad:PostalDescriptor` → its `ad:postCode`.
	 *
	 * Twenty-six descriptors over nineteen municipalities, so a code may appear twice:
	 * `BE.BRUSSELS.BRIC.ADM.MZ.13` and `.MZ.18` both hold `1050`.
	 */
	postcodes: ReadonlyMap<string, string>
	/**
	 * `ad:AdminUnitName` at {@link MUNICIPALITY_LEVEL} → the municipality name, NIS code removed.
	 *
	 * A unit at another level is left out, so the country, region, province
	 * and district references cannot answer for a locality.
	 */
	municipalities: ReadonlyMap<string, string>
}

/**
 * Indexes the three component types in one pass over the member's head.
 *
 * The pass runs to the end of the member rather than stopping at the first address, because the
 * component-before-address order is a measurement of this file rather than a rule of the schema.
 *
 * @throws {@linkcode InspireArchiveError} when a component states no `gml:id`,
 * when two components share one, or when the pass ends with an empty index.
 */
export async function readBrusselsComponents(
	inputPath: AdapterOptions["inputPath"],
	signal?: AbortSignal
): Promise<BrusselsComponentIndex> {
	const streets = new Map<string, string>()
	const postcodes = new Map<string, string>()
	const municipalities = new Map<string, string>()
	const seen = new Set<string>()

	for await (const feature of streamMarkupElements(inspireGMLChunks(inputPath, GML_MEMBER), COMPONENT_TYPES, {
		xml: true,
		signal,
	})) {
		const id = feature.attributes["gml:id"]

		if (!id) {
			throw new InspireArchiveError(
				BRUSSELS_ADAPTER_ID,
				`a ${feature.name} feature states no gml:id, so no address can reference it`
			)
		}

		// Every one of 6,287 component ids measured is distinct.
		// An overwritten entry would substitute one street for another on every address naming it.
		if (seen.has(id)) {
			throw new InspireArchiveError(
				BRUSSELS_ADAPTER_ID,
				`two component features share the gml:id ${stringifyJSON(id)}. All 6,287 ids in the file ` +
					`measured are distinct, so a reference can no longer be resolved to one feature.`
			)
		}

		seen.add(id)

		if (feature.name === "ad:ThoroughfareName") {
			const street = thoroughfareName(feature)

			if (street !== undefined) {
				streets.set(id, street)
			}
		} else if (feature.name === "ad:PostalDescriptor") {
			const postcode = postalDescriptorCode(feature)

			if (postcode !== undefined) {
				postcodes.set(id, postcode)
			}
		} else if (adminUnitLevel(feature) === MUNICIPALITY_LEVEL) {
			const municipality = placeNameWithoutNISCode(placeName(feature))

			if (municipality !== undefined) {
				municipalities.set(id, municipality)
			}
		}
	}

	// An aborted pass stopped mid-member, so an empty index states that the caller cancelled
	// rather than that the publication is incomplete.
	if (signal?.aborted) return { streets, postcodes, municipalities }

	for (const [typeName, index] of [
		["ad:ThoroughfareName", streets],
		["ad:PostalDescriptor", postcodes],
		["ad:AdminUnitName", municipalities],
	] as const) {
		if (!index.size) {
			throw new InspireArchiveError(
				BRUSSELS_ADAPTER_ID,
				`the archive holds no ${typeName} feature this adapter can join. Every address references all ` +
					`three component types, so an empty index turns every row into a row with no street rather ` +
					`than into fewer rows.`
			)
		}
	}

	return { streets, postcodes, municipalities }
}

/**
 * What the adapter refused, counted by reason.
 *
 * Each count is reported rather than folded into the yield, so a run states what it dropped and why.
 */
interface Refusals {
	/**
	 * The publisher stated no house number, having written no `buildingIdentifier` designator.
	 */
	absentHouseNumber: number
	/**
	 * The publisher marked the house number void, so the value could not be read.
	 */
	voidHouseNumber: number
	/**
	 * The address states no postal zone, having written its reference empty.
	 *
	 * Nine addresses in the file measured.
	 * Counted apart from {@link Refusals.unjoined} because the reference is absent rather than
	 * unanswerable, and a reader that skips an empty href silently yields these rows with no postcode.
	 */
	noPostcode: number
	/**
	 * A reference the component index cannot answer, or a component the address never referenced.
	 */
	unjoined: number
	/**
	 * An address the codex could not render into a line.
	 */
	unrendered: number
}

export function createBrusselsAdapter(): CorpusAdapter {
	return {
		id: BRUSSELS_ADAPTER_ID,
		defaultLicense: BRUSSELS_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: BRUSSELS_SOURCE_REGISTER,
		surface: SurfaceOrigin.Rendered,
		description:
			"INSPIRE Addresses (UrbIS, Brussels Regional Informatics Centre): house-number-level addresses for the Brussels-Capital Region.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !BRUSSELS_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(BRUSSELS_ADAPTER_ID, BRUSSELS_COUNTRIES, opts.country)
			}

			// Checked before the archive is opened, so a caller that cancelled first pays no inflation.
			if (opts.signal?.aborted) return

			const index = await readBrusselsComponents(opts.inputPath, opts.signal)

			if (opts.signal?.aborted) return

			let emitted = 0

			const refused: Refusals = {
				absentHouseNumber: 0,
				voidHouseNumber: 0,
				noPostcode: 0,
				unjoined: 0,
				unrendered: 0,
			}

			try {
				for await (const address of streamMarkupElements(inspireGMLChunks(opts.inputPath, GML_MEMBER), "ad:Address", {
					xml: true,
					signal: opts.signal,
				})) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					// `designatorsByType` leaves out a designator the publisher marked void, so a void number
					// and an absent one both read as undefined and `voidDesignatorTypes` separates them below.
					const house = designator(designatorsByType(address), HOUSE_NUMBER_DESIGNATOR)

					if (house === undefined) {
						// A void number is a value this run could not read and an absent one is
						// a number the publisher states the address has none of.
						// Neither is emitted, and the two are counted apart so a run reports which it met.
						if (voidDesignatorTypes(address).has(HOUSE_NUMBER_DESIGNATOR)) {
							refused.voidHouseNumber++
						} else {
							refused.absentHouseNumber++
						}

						continue
					}

					// Written rather than counted off `componentHrefs`, which skips an empty href:
					// the difference between seven slots and seven readable references is
					// exactly the nine addresses whose postal zone is empty.
					const slots = componentHrefs(address)

					let street: string | undefined
					let postcode: string | undefined
					let locality: string | undefined

					for (const href of slots) {
						const key = componentJoinKey(href)

						if (key === undefined) continue

						street = index.streets.get(key) ?? street
						postcode = index.postcodes.get(key) ?? postcode
						// The country, region, province and district references are indexed out by level,
						// so they reach here with no municipality and are not defects.
						locality = index.municipalities.get(key) ?? locality
					}

					if (postcode === undefined && slots.length < COMPONENTS_PER_ADDRESS) {
						// The publisher wrote the postal-zone reference empty.
						// The row is refused and reported rather than yielded with the postcode missing,
						// because an unstated value is not an address without a postcode.
						refused.noPostcode++

						continue
					}

					// A component the index cannot answer is a street, postcode or locality this run could not read.
					// A row emitted without it would record an absence the publisher never stated.
					if (street === undefined || postcode === undefined || locality === undefined) {
						refused.unjoined++

						continue
					}

					const rendered = formatAddressRow({ house_number: house, street, postcode, locality }, "BE", {
						singleLine: true,
					})

					if (!rendered) {
						refused.unrendered++

						continue
					}

					const { raw, components: aligned } = rendered
					// `gml:id` is `BE.BRUSSELS.BRIC.ADM.ADPT.<localId>`, unique in the publication
					// and written in the file rather than derived, so two runs over one archive agree on it.
					const seed = address.attributes["gml:id"]?.trim()

					yield {
						raw,
						components: aligned,
						country: "BE",
						// The region is bilingual and the file writes both spellings,
						// French first on every street and administrative unit.
						// The row takes the French one, so the locale states which of the two it is
						// rather than leaving it to the country.
						locale: "fr-BE",
						source: BRUSSELS_ADAPTER_ID,
						source_id: seed ? `${BRUSSELS_ADAPTER_ID}-${seed}` : stableSourceID(BRUSSELS_ADAPTER_ID, aligned),
						corpus_version: "",
						license: BRUSSELS_DEFAULT_LICENSE,
					}

					emitted++
				}
			} finally {
				const dropped =
					refused.absentHouseNumber +
					refused.voidHouseNumber +
					refused.noPostcode +
					refused.unjoined +
					refused.unrendered

				if (dropped > 0) {
					process.stderr.write(
						`  brussels: ${emitted} rows kept, ${dropped} refused ` +
							`(${refused.noPostcode} write their postal-zone reference empty, ` +
							`${refused.unjoined} hold a reference the archive cannot answer, ` +
							`${refused.voidHouseNumber} state a void house number, ` +
							`${refused.absentHouseNumber} state no house number, ` +
							`${refused.unrendered} did not render)\n`
					)
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const brusselsAdapter = createBrusselsAdapter()
