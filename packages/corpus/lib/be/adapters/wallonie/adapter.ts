/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `wallonie`: the INSPIRE Addresses (AD) theme the Service public de Wallonie publishes out of its
 * ICAR address-point register.
 *
 * Coverage is the Walloon Region rather than Belgium. Belgium needs three readers, because each
 * region publishes the theme through its own service: Flanders through a WFS (`vlaanderen`),
 * Brussels through a bare HTTP download (`brussels`), and Wallonia through the ATOM service below.
 * Every row this adapter emits is `BE`, and any other `opts.country` raises
 * {@linkcode UnsupportedCountryError}.
 *
 * The schema-level reading is `#inspire/address`, which owns every part of an `ad:Address` the
 * publishers spell alike. This module holds only what is Wallonia's own: the two-pass join its
 * document order forces, and the number extension it writes on every address.
 *
 * ## The publication
 *
 * The ATOM service document is `https://geoservices.wallonie.be/inspire/atom/AD_Service.xml`, 9,935
 * bytes, with one entry. That entry's dataset feed offers one archive for the whole region:
 * `…/spwdatadownload/results/b62f8405-2ce3-449f-8a61-5fc2f38d8b73/AD.Addresses.gml.zip`,
 * 106,665,832 bytes, sha256 `8eebae71d793632c22c9902e8420bc50e0e572c97de15b7d10051b29b59e208a`,
 * holding one deflate member `AD.Addresses.gml` of 5,163,917,131 bytes. The archive is 48 times
 * smaller than what it holds, so the member is streamed and never buffered.
 *
 * The host ignores `Range`: a `bytes=0-4194303` request answers HTTP 200 with the whole body and no
 * `content-range`, so there is no prefix to sample and every measurement below is over all
 * 5,163,917,131 bytes.
 *
 * Counts, read 2026-10-02 with {@linkcode streamMarkupElements} and reconciled against a second
 * instrument that extracted `gml:featureMember` blocks from the same stream as text: 1,772,312
 * `ad:Address`, 55,766 `ad:ThoroughfareName`, 1,963 `ad:AddressAreaName`, 598 `ad:PostalDescriptor`
 * and 264 `ad:AdminUnitName`. The two instruments agree, and they reconcile: 1,772,312 addresses plus
 * 58,591 component features is the 1,830,903 `gml:featureMember` elements the file holds, and the
 * component total is the number of distinct component `gml:id` values. The address count is also the
 * one the address-source register records for `be-property-building-2`.
 *
 * Every component `gml:id` is distinct. Over 58,591 component features, 0 ids repeat, so the index
 * below states no collision rule and raises on a collision instead. A replaced entry would
 * substitute one street for another on every address referencing it.
 *
 * ## Why the join takes two passes
 *
 * Wallonia writes all 1,772,312 addresses before the first component feature. Measured by resolving
 * each reference against the components indexed so far, all 10,633,872 references are forward
 * references: 0 resolve in a single pass. ČÚZK's one-pass reader with a deferred tail cannot be used
 * here, because deferring every address means holding 1.77 million subtrees in memory.
 *
 * So the member is inflated twice. The first pass indexes the four component types — 58,591 entries,
 * bounded and small — and the second streams the addresses and joins locally. Two inflations of
 * 5,163,917,131 bytes cost less than one buffered document.
 *
 * Each address writes exactly 6 `ad:component` references, 10,633,872 over the file, and each one
 * addresses a `gml:id` in the same document. Four are the region's own
 * (`BE.WL.ICAR.ThoroughfareName`, `AdminUnitName`, `PostalDescriptor`, `AddressAreaName`) and two are
 * the country and the region, `#BE.AdminUnitName.1000` (`Belgique`, `1stOrder`) and
 * `#BE.AdminUnitName.3000` (`Région wallonne`, `2ndOrder`). The index keeps an administrative unit
 * only at {@link MUNICIPALITY_LEVEL}, so those two resolve to no entry and are a reference the
 * adapter declines rather than a defect — the same shape Flanders' `refnis1995_1000` reference has.
 *
 * ## The number extension, read and deliberately not rendered
 *
 * Every address writes two inline designators: `addressIdentifierGeneral` holds the house
 * number and `addressNumberExtension` holds a four-character code. `ad:level` is
 * `postalDeliveryPoint` on every address, so a row is a letterbox rather than a building, and the
 * extension distinguishes letterboxes at one number: `93` appears with `B001` and `C003`, and `29`
 * with `0014`, `B004`, `B007`, `C009` and `D015`. Other observed values are `0001`, `A001`, `008B`,
 * `BP3` and `0RCH`.
 *
 * The element is written on all 1,772,312 addresses and holds a value on 347,859 of them, measured by
 * running this adapter over the whole archive. The other 1,424,453, 80.4%, write
 * `addressNumberExtension` with its `ad:designator` empty. That empty element is the publisher
 * stating that the address has no extension rather than omitting the field.
 *
 * So the extension is read, counted and left out of the rendered line. This publication states no
 * rule for writing a value of it into an address: unlike ČÚZK, Wallonia publishes no formatted
 * address of its own to compare a rendering against, and appending `0RCH` or `B001` to the number
 * would invent a surface for 347,859 rows. A publisher-rendered line, or a statement of what the
 * field holds, is what would decide it.
 *
 * The consequence is recorded rather than hidden: two addresses differing only by extension render
 * the same line. They keep distinct `source_id` values, each the address's own `gml:id`, so the
 * duplication is visible to a later dedup step rather than collapsed here.
 *
 * ## Voids
 *
 * Every void in this file states a reason. Over the whole member, 1,830,903 `ad:validTo` and
 * 1,830,903 `ad:endLifespanVersion` elements, 57,997 `gn:pronunciation`, `gn:grammaticalGender` and
 * `gn:grammaticalNumber` each, 2,823 `ad:validFrom` and 264 `ad:adminUnit` are `xsi:nil="true"` with
 * a `nilReason`, and 0 nil elements omit the reason. No value this adapter reads was void in the file
 * measured. Brussels is the opposite case, writing no reason on any void, and `isVoid` in
 * `#inspire/address` keys on `xsi:nil` rather than on a reason for that reason. This adapter reads
 * the same primitives, so a Walloon void that stopped stating a reason would still read as a void.
 *
 * ## Coordinates
 *
 * This adapter emits text and components only, because {@linkcode CanonicalRow} declares no position
 * field. The file's axis order is recorded here for whoever does emit one. Wallonia declares
 * `srsName="http://www.opengis.net/def/crs/EPSG/0/3035"` and complies with that authority's
 * northing-then-easting order: `gml:pos` `3079047.229041581 3924386.42904076` reads as latitude
 * 50.686064, longitude 4.381708, in Braine-l'Alleud. That is the municipality the same address's own
 * `ad:AdminUnitName` names. Its `gml:boundedBy` lower corner, `2942208.441255148 3816649.462808032`,
 * puts the smaller number first in the same way. Brussels declares the same CRS and writes
 * easting-northing, so the two publishers disagree and a reader cannot take the declaration at its
 * word. `brussels/adapter.ts` records that measurement.
 *
 * ## Terms
 *
 * The address-source register elects `Licence CC-BY 4.0, as the Service public de Wallonie states it`
 * for `be-property-building-2`, under license id
 * `unchecked-access-free-be-service-public-de-wallonie-spw`, and that decision records
 * `spdx: "CC-BY-4.0"`. `electedLicenseLabel` answers an elected decision's `spdx` before its
 * `electedTerms`, so {@linkcode WALLONIE_DEFAULT_LICENSE} is the SPDX id rather than the French
 * sentence. The register's own words for what the publisher permits are use, modification into a
 * derived work, and publication of both, on condition that the sources are cited, so a model card
 * states `Source : Service public de Wallonie (SPW) - INSPIRE - Points d'adresses en Wallonie (BE)
 * (2017-11-20) https://geodata.wallonie.be/id/b62f8405-2ce3-449f-8a61-5fc2f38d8b73`.
 *
 * That row declares no `adapterID`, so `createIneligibilityReader` refuses every row this adapter
 * emits until a review sets `adapterID` to `wallonie` on it. The refusal is by construction and
 * states itself in the build manifest.
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
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 * The name is the region as its own publisher writes it, as `vlaanderen`'s is.
 */
export const WALLONIE_ADAPTER_ID = "wallonie"

/**
 * The stable id of the publication behind every row.
 *
 * It belongs in `SourceRegister` beside `be-vlaanderen-inspire-ad`, and this constant
 * stands in until that entry lands, because a built corpus stores the id on every row
 * and the id must not change afterwards.
 * Replace the constant with the `SourceRegister` member on integration.
 */
export const WALLONIE_SOURCE_REGISTER = SourceRegister.WallonieInspireAddresses

/**
 * The one jurisdiction this adapter emits.
 *
 * The service publishes the Walloon Region, to which ISO 3166-1 assigns no
 * code of its own, so the set holds one code and a caller naming another gets
 * {@linkcode UnsupportedCountryError} rather than zero rows.
 */
export const WALLONIE_COUNTRIES: readonly string[] = ["BE"]

/**
 * The licence recorded on every row.
 *
 * The register's elected decision for `unchecked-access-free-be-service-public-de-wallonie-spw`
 * records `spdx: "CC-BY-4.0"`, and `electedLicenseLabel` answers the SPDX id when one is recorded.
 */
export const WALLONIE_DEFAULT_LICENSE = "CC-BY-4.0"

/**
 * The archive member holding the GML.
 *
 * A pattern rather than the literal `AD.Addresses.gml`, so a republication
 * that renames the member still reads.
 * The archive measured holds exactly one member.
 */
const GML_MEMBER = /\.gml$/iu

/**
 * The designator type Wallonia writes its house number under.
 *
 * `ad:LocatorDesignator` repeats and is typed, so the number is selected by this term
 * rather than by position.
 * Czechia and Brussels write `buildingIdentifier` and the Netherlands `addressNumber` for the same part.
 *
 * `#inspire/address` therefore leaves the vocabulary to the caller.
 */
const HOUSE_NUMBER_DESIGNATOR = "addressIdentifierGeneral"

/**
 * The designator type carrying the letterbox code beside the number.
 *
 * Read and counted rather than rendered, for the reason this file's header states.
 */
const NUMBER_EXTENSION_DESIGNATOR = "addressNumberExtension"

/**
 * The `ad:level` of the administrative unit carrying the municipality name.
 *
 * An address references three administrative units: the municipality at `5thOrder`,
 * the region at `2ndOrder` (`Région wallonne`) and the country at `1stOrder` (`Belgique`).
 * A reader that took whichever arrived first would write `Belgique` into the `locality` of some rows.
 */
const MUNICIPALITY_LEVEL = "5thOrder"

/**
 * The component feature types the first pass indexes.
 *
 * All four are read in one pass, because the publisher writes them interleaved
 * in the file's tail rather than grouped by type.
 */
const COMPONENT_TYPES = [
	"ad:ThoroughfareName",
	"ad:PostalDescriptor",
	"ad:AdminUnitName",
	"ad:AddressAreaName",
] as const

/**
 * Raised when the archive cannot answer what the adapter asked it for.
 *
 * A file holding no component feature cannot be read as a smaller publication:
 * every address references all six components, so an empty index turns every row
 * into a row with no street rather than into fewer rows.
 */
export class WallonieArchiveError extends Error {
	constructor(message: string) {
		super(`${WALLONIE_ADAPTER_ID} adapter: ${message}`)

		this.name = "WallonieArchiveError"
	}
}

/**
 * The components an address references, keyed by the `gml:id` its `#` fragment names.
 */
export interface WallonieComponentIndex {
	/**
	 * `ad:ThoroughfareName` → the street name the publisher spells.
	 */
	streets: ReadonlyMap<string, string>
	/**
	 * `ad:PostalDescriptor` → its `ad:postCode`.
	 */
	postcodes: ReadonlyMap<string, string>
	/**
	 * `ad:AdminUnitName` at {@link MUNICIPALITY_LEVEL} → the municipality name.
	 *
	 * A unit at another level is left out, so the country and region references cannot answer for a locality.
	 */
	municipalities: ReadonlyMap<string, string>
	/**
	 * `ad:AddressAreaName` → the name of the part of the municipality, such as `Hamme-Mille` in `Beauvechain`.
	 */
	areas: ReadonlyMap<string, string>
}

/**
 * Indexes the four component types in one pass over the member.
 *
 * @throws {@linkcode WallonieArchiveError} when a component states no `gml:id`,
 * when two components share one, or when the pass ends with an empty index.
 */
export async function readWallonieComponents(
	inputPath: AdapterOptions["inputPath"],
	signal?: AbortSignal
): Promise<WallonieComponentIndex> {
	const streets = new Map<string, string>()
	const postcodes = new Map<string, string>()
	const municipalities = new Map<string, string>()
	const areas = new Map<string, string>()
	const seen = new Set<string>()

	for await (const feature of streamMarkupElements(inspireGMLChunks(inputPath, GML_MEMBER), COMPONENT_TYPES, {
		xml: true,
		signal,
	})) {
		const id = feature.attributes["gml:id"]

		if (!id) {
			throw new WallonieArchiveError(`a ${feature.name} feature carries no gml:id, so nothing can reference it`)
		}

		// Every one of 58,591 component ids measured is distinct.
		// An overwritten entry would substitute one street for another on every address naming it.
		if (seen.has(id)) {
			throw new WallonieArchiveError(
				`two component features share the gml:id ${stringifyJSON(id)}. All 58,591 ids in the file ` +
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
		} else if (feature.name === "ad:AddressAreaName") {
			const area = placeName(feature)

			if (area !== undefined) {
				areas.set(id, area)
			}
		} else if (adminUnitLevel(feature) === MUNICIPALITY_LEVEL) {
			const municipality = placeName(feature)

			if (municipality !== undefined) {
				municipalities.set(id, municipality)
			}
		}
	}

	// An aborted pass stopped mid-member, so an empty index states that the caller cancelled
	// rather than that the publication is incomplete.
	if (signal?.aborted) return { streets, postcodes, municipalities, areas }

	for (const [typeName, index] of [
		["ad:ThoroughfareName", streets],
		["ad:PostalDescriptor", postcodes],
		["ad:AdminUnitName", municipalities],
		["ad:AddressAreaName", areas],
	] as const) {
		if (!index.size) {
			throw new WallonieArchiveError(
				`the archive holds no ${typeName} feature this adapter can join. Every address references all ` +
					`four component types, so an empty index turns every row into a row with no street rather ` +
					`than into fewer rows.`
			)
		}
	}

	return { streets, postcodes, municipalities, areas }
}

/**
 * What the adapter refused, counted by reason.
 *
 * Each count is reported rather than folded into the yield, so a run states what it dropped and why.
 */
interface Refusals {
	/**
	 * The publisher stated no house number, having written no `addressIdentifierGeneral` designator.
	 */
	absentHouseNumber: number
	/**
	 * The publisher marked the house number void, so the value could not be read.
	 */
	voidHouseNumber: number
	/**
	 * A reference the component index cannot answer, or a component the address never referenced.
	 */
	unjoined: number
	/**
	 * An address the codex could not render into a line.
	 */
	unrendered: number
}

export function createWallonieAdapter(): CorpusAdapter {
	return {
		id: WALLONIE_ADAPTER_ID,
		defaultLicense: WALLONIE_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: WALLONIE_SOURCE_REGISTER,
		surface: SurfaceOrigin.Rendered,
		description: "INSPIRE Addresses (Service public de Wallonie): house-number-level addresses for the Walloon Region.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !WALLONIE_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(WALLONIE_ADAPTER_ID, WALLONIE_COUNTRIES, opts.country)
			}

			// Checked before the archive is opened, so a caller that cancelled first pays no inflation.
			if (opts.signal?.aborted) return

			const index = await readWallonieComponents(opts.inputPath, opts.signal)

			if (opts.signal?.aborted) return

			let emitted = 0
			let extensions = 0
			const refused: Refusals = { absentHouseNumber: 0, voidHouseNumber: 0, unjoined: 0, unrendered: 0 }

			try {
				for await (const address of streamMarkupElements(inspireGMLChunks(opts.inputPath, GML_MEMBER), "ad:Address", {
					xml: true,
					signal: opts.signal,
				})) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					// `designatorsByType` leaves out a designator the publisher marked void, so a void number
					// and an absent one both read as undefined and `voidDesignatorTypes` separates them below.
					const byType = designatorsByType(address)
					const house = designator(byType, HOUSE_NUMBER_DESIGNATOR)

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

					if (designator(byType, NUMBER_EXTENSION_DESIGNATOR) !== undefined) {
						extensions++
					}

					let street: string | undefined
					let postcode: string | undefined
					let locality: string | undefined
					let area: string | undefined

					for (const href of componentHrefs(address)) {
						const key = componentJoinKey(href)

						if (key === undefined) continue

						street = index.streets.get(key) ?? street
						postcode = index.postcodes.get(key) ?? postcode
						// The country and region references are indexed out by level,
						// so they reach here with no municipality and are not defects.
						locality = index.municipalities.get(key) ?? locality
						area = index.areas.get(key) ?? area
					}

					// A component the index cannot answer is a street, postcode or locality this run could not read.
					// A row emitted without it would record an absence the publisher never stated.
					if (street === undefined || postcode === undefined || locality === undefined) {
						refused.unjoined++

						continue
					}

					const components: CanonicalRow["components"] = {
						house_number: house,
						street,
						postcode,
						locality,
					}

					// The `partie de commune` is a dependent locality only where it names
					// something other than the municipality.
					// `Braine-l'Alleud` has an area of the same name, and `Beauvechain` has `Hamme-Mille`.
					if (area !== undefined && area !== locality) {
						components.dependent_locality = area
					}

					const rendered = formatAddressRow(components, "BE", { singleLine: true })

					if (!rendered) {
						refused.unrendered++

						continue
					}

					const { raw, components: aligned } = rendered
					// `gml:id` is `BE.WL.ICAR.Address.<localId>`, unique in the publication and written
					// in the file rather than derived, so two runs over one archive agree on it.
					const seed = address.attributes["gml:id"]?.trim()

					yield {
						raw,
						components: aligned,
						country: "BE",
						// Every component name is read in French: `gn:language` is `fre` on the first
						// `ad:name` of each feature, and the country and region features add `ger`
						// and `dut` spellings after it that `placeName` does not reach.
						locale: "fr-BE",
						source: WALLONIE_ADAPTER_ID,
						source_id: seed ? `${WALLONIE_ADAPTER_ID}-${seed}` : stableSourceID(WALLONIE_ADAPTER_ID, aligned),
						corpus_version: "",
						license: WALLONIE_DEFAULT_LICENSE,
					}

					emitted++
				}
			} finally {
				const dropped = refused.absentHouseNumber + refused.voidHouseNumber + refused.unjoined + refused.unrendered

				if (dropped > 0) {
					process.stderr.write(
						`  wallonie: ${emitted} rows kept, ${dropped} refused ` +
							`(${refused.unjoined} hold a reference the archive cannot answer, ` +
							`${refused.voidHouseNumber} state a void house number, ` +
							`${refused.absentHouseNumber} state no house number, ` +
							`${refused.unrendered} did not render)\n`
					)
				}

				if (extensions > 0) {
					process.stderr.write(
						`  wallonie: ${extensions} of ${emitted} rows kept carry an addressNumberExtension ` +
							`that the rendered line leaves out\n`
					)
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const wallonieAdapter = createWallonieAdapter()
