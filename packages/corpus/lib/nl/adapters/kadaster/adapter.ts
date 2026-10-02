/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `nl-kadaster`: the INSPIRE Addresses theme Kadaster publishes, read from its national GML.
 *
 * Kadaster serves the whole country in one file. The ATOM service document at
 * `https://service.pdok.nl/kadaster/ad/atom/adressen_inspire_geharmoniseerd.xml`, 2,247 bytes, holds
 * one entry, and its `rel="alternate"` link is
 * `https://service.pdok.nl/kadaster/ad/atom/downloads/addresses.gml.gz`, 819,465,603 bytes, which
 * inflates to 29,677,448,685 bytes of GML holding 10,066,060 address features. The sibling feed URL
 * the entry's own `<id>` names answers HTTP 404, so the download link is the only live one.
 *
 * The size decides the shape of the reader. The document is never buffered: the adapter opens the
 * local `.gml.gz`, inflates it as a byte stream and takes one feature subtree at a time, and it keeps
 * a value rather than a subtree for each feature an address references, so the index it holds is
 * bounded by a string per street and per place name rather than by the document.
 *
 * Four things separate this publisher from the Czech one the shared primitives were first written
 * against, and each was measured over a 40,000,000-byte ranged prefix of the download, read in one
 * streaming pass:
 *
 * 1. The wrapper is `gml:FeatureCollection` with `gml:featureMember`, where ČÚZK writes
 *    `base:SpatialDataSet` with `base:member`.
 * 2. Every `ad:component` reference is a local `#` fragment naming a `gml:id` in the same document,
 *    and 0 of them went unresolved.
 * 3. The postcode is inline. The prefix holds 0 `ad:PostalDescriptor` features, and the postcode
 *    arrives as a locator designator typed `postalDeliveryIdentifier`. Its element is present on all
 *    40,000 addresses read in the final pass and empty on 1,769 of them, so an address with no
 *    postcode is ordinary here and the publisher's own rendering agrees: Kadaster's Locatieserver
 *    writes `De Paasweide 72g-11, Appingedam` for one of them, with no postcode.
 * 4. The number is typed `addressNumber`, and two further types hold the rest of it.
 *
 * The number is assembled from three designators, and Kadaster's own rendering of the same records
 * fixes how. BAG's `huis_nlt` is the house number as Kadaster writes it, and the Locatieserver serves
 * it beside the `nummeraanduiding` id that this theme's `base:localId` repeats. Three records of the
 * fixture, matched by that id:
 *
 * | `gml:id` | `addressNumber` | `addressNumberExtension` | `addressNumber2ndExtension` | `huis_nlt` |
 * | --- | --- | --- | --- | --- |
 * | `…address.0003200000140702` | `72` | `g` | `11` | `72g-11` |
 * | `…address.0003200000134065` | `10` | (empty) | `I` | `10-I` |
 * | `…address.0003200000134593` | `4` | (empty) | `01` | `4-01` |
 *
 * So the extension joins the number with no separator and the second extension follows a hyphen.
 * 305,542 of 345,309 addresses in the prefix write an `addressNumberExtension` that is present and
 * empty, spelled `<ad:designator/>`. That states an address with no extension, which is a different
 * condition from void.
 *
 * The place name comes from `ad:AddressAreaName`, the BAG *woonplaats*. The prefix holds exactly one
 * `ad:AdminUnitName` feature and it is the country, `Nederland` at `1stOrder`, so this feed publishes
 * no municipality name and the woonplaats is the finest place name available. An address references
 * that country feature, so the adapter indexes the type and reads no place name from it.
 *
 * One published defect shapes what the adapter refuses to do. `ad:situatedWithin` on an
 * `ad:ThoroughfareName` writes its target with a hyphen where every `gml:id` uses a dot:
 * `#nl-imbag-ad-addressareaname-3386` against `gml:id="nl-imbag-ad-addressareaname.1000"`. Measured
 * over a 5,000,000-character window, 479 local fragments resolved to no feature, all of that shape,
 * against 2,622 dot-form ids and 0 hyphen-form ids. The same element on an `ad:AddressAreaName` uses
 * the dot form and resolves. A reader walking `ThoroughfareName → situatedWithin → AddressAreaName`
 * would therefore read an empty locality for every street and report no failure. So the adapter reads
 * the street and the place from the address's own `ad:component` references, which use the dot form,
 * and never follows `ad:situatedWithin`. Every reference it does follow raises when it resolves to no
 * feature, so the hyphen form reaching an `ad:component` would be reported rather than dropped.
 *
 * Unlike Czechia, this publisher offers no string to check a whole rendered line against.
 * `ad:alternativeIdentifier` is void on every address. The Locatieserver's `weergavenaam` is the
 * nearest equivalent, and `adapter.test.ts` pins the twelve fixture rows against it.
 *
 * Kadaster states one licence and states it as a URL. Both `rights` elements of the ATOM service
 * document read `https://creativecommons.org/publicdomain/zero/1.0/deed.nl`, the Dutch deed page for
 * CC0 1.0 Universal, which the address-source register elected with `spdx` `CC0-1.0`. CC0 reserves no
 * act, so every row records that identifier and no attribution clause is owed, although crediting
 * Kadaster stays good practice.
 *
 * The adapter honors `opts.limit` and `opts.signal`. `opts.country` is optional and accepts only `NL`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { gunzipChunks } from "@mailwoman/core/fs/compression"
import { openReadStream } from "@mailwoman/core/fs/streams"
import type { MarkupElement } from "@mailwoman/core/html/elements"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { composeHouseNumber } from "#adapters/street-line"
import {
	adminUnitLevel,
	componentHrefs,
	componentJoinKey,
	designator,
	designatorsByType,
	placeName,
	thoroughfareName,
	voidDesignatorTypes,
} from "#inspire/address"
import { UnresolvedComponentReferenceError, VoidDesignatorError } from "#inspire/errors"
import { streamInspireRows } from "#inspire/stream"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const NL_KADASTER_ADAPTER_ID = "nl-kadaster"

/**
 * The publication this adapter reads.
 *
 * The literal stands in for a `SourceRegister` member until `lib/registers.ts` declares
 * `KadasterInspireAddresses: "nl-kadaster-inspire-ad"`, which is the id this value spells.
 */
export const NL_KADASTER_REGISTER = SourceRegister.KadasterInspireAddresses

/**
 * The one jurisdiction this adapter emits.
 *
 * The download covers the Netherlands in Europe.
 * The Caribbean parts of the Kingdom keep their own cadastres.
 *
 * Those cadastres publish no INSPIRE Addresses theme, so the set has one member.
 */
export const NL_KADASTER_COUNTRIES: readonly string[] = ["NL"]

/**
 * The licence the address-source register elected for this publisher.
 *
 * `unchecked-access-free-nl-kadaster` is elected with `electedTerms`
 * `Creative Commons CC0 1.0 Universal Public Domain Dedication` and `spdx` `CC0-1.0`,
 * read from the two `rights` elements of the ATOM service document.
 */
export const NL_KADASTER_DEFAULT_LICENSE = "CC0-1.0"

/**
 * The INSPIRE feature types the adapter reads from the document.
 *
 * `ad:ThoroughfareName` holds the street and `ad:AddressAreaName` the woonplaats.
 * `ad:AdminUnitName` is indexed because an address references the country feature
 * and a reference resolving to no feature raises.
 * No place name is read from it.
 *
 * `ad:PostalDescriptor` is deliberately absent.
 * The publisher writes none, and a reference to one would resolve to no feature
 * and be reported rather than silently read as an address with no postcode.
 *
 * All four are read in one pass, because the document writes the referenced features and the addresses
 * interleaved over 29,677,448,685 bytes and a pass per type would inflate the download once per type.
 */
const COMPONENT_TYPES = ["ad:ThoroughfareName", "ad:AddressAreaName", "ad:AdminUnitName"] as const

/**
 * What one referenced feature contributes to an address.
 *
 * A value rather than the feature's subtree, because the national document holds hundreds of
 * thousands of them and a subtree holds its geometry, its lifespan and its name metadata.
 */
interface ReferencedValue {
	/**
	 * The feature's element name, which decides where its value goes.
	 */
	readonly type: string

	/**
	 * The street name or place name the feature states, absent when the feature states none.
	 */
	readonly name?: string

	/**
	 * The administrative level an `ad:AdminUnitName` states, such as `1stOrder`.
	 */
	readonly level?: string
}

/**
 * The value a referenced feature contributes, read once as the feature arrives.
 */
function referencedValue(feature: MarkupElement): ReferencedValue {
	if (feature.name === "ad:ThoroughfareName") {
		return { type: feature.name, name: thoroughfareName(feature) }
	}

	if (feature.name === "ad:AdminUnitName") {
		return { type: feature.name, name: placeName(feature), level: adminUnitLevel(feature) }
	}

	return { type: feature.name, name: placeName(feature) }
}

/**
 * The house number as Kadaster writes it in BAG's `huis_nlt`.
 *
 * The letter joins the number directly and the addition follows a hyphen,
 * which the table in this module's header reads off three records matched against
 * the Locatieserver by their `nummeraanduiding` id.
 *
 * @returns The joined number, or undefined when the publisher states no `addressNumber`.
 */
export function dutchHouseNumber(byType: ReadonlyMap<string, readonly string[]>): string | undefined {
	const number = designator(byType, "addressNumber")

	if (!number) return undefined

	const letter = designator(byType, "addressNumberExtension") ?? ""
	const addition = designator(byType, "addressNumber2ndExtension") ?? ""

	return composeHouseNumber(composeHouseNumber(number, letter), addition, "-")
}

export function createNLKadasterAdapter(): CorpusAdapter {
	return {
		id: NL_KADASTER_ADAPTER_ID,
		defaultLicense: NL_KADASTER_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: NL_KADASTER_REGISTER,
		surface: SurfaceOrigin.Rendered,
		description:
			"INSPIRE Addresses (Kadaster): house-number-level addresses for the Netherlands, one national gzipped GML.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !NL_KADASTER_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(NL_KADASTER_ADAPTER_ID, NL_KADASTER_COUNTRIES, opts.country)
			}

			let emitted = 0

			for (const documentPath of await documentPaths(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				// The published document writes 300,318 referenced features ahead of its first address
				// and held 0 of 345,309 measured, so the driver's holding list stays empty here.
				// It exists because only the document's own ordering separates a reference
				// that has not arrived yet from one the publisher never wrote.
				for await (const row of streamInspireRows<ReferencedValue>({
					chunks: documentChunks(documentPath),
					componentElements: COMPONENT_TYPES,
					// One string per feature rather than its subtree, which holds 300,318 strings
					// instead of 300,318 trees.
					index: referencedValue,
					compose: (address, referenced, final) => composeRow(address, referenced, { final }),
					limit: opts.limit === undefined ? undefined : opts.limit - emitted,
					signal: opts.signal,
				})) {
					yield row

					emitted++
				}
			}
		},
	}
}

/**
 * One address's row, `undefined` when it holds too little to render, or `"deferred"`
 * when a reference it states is not indexed yet.
 *
 * With `final` set the document has ended, so an unresolved reference is a value the reader
 * asked for and could not read, and it raises rather than rendering the address without it.
 */
function composeRow(
	address: MarkupElement,
	referenced: ReadonlyMap<string, ReferencedValue>,
	options: { final?: boolean } = {}
): CanonicalRow | undefined | "deferred" {
	const addressID = address.attributes["gml:id"]?.trim()
	const voided = voidDesignatorTypes(address)

	for (const type of ["addressNumber", "postalDeliveryIdentifier"]) {
		if (voided.has(type)) throw new VoidDesignatorError(NL_KADASTER_ADAPTER_ID, addressID, type)
	}

	let street: string | undefined
	let locality: string | undefined

	for (const href of componentHrefs(address)) {
		const key = componentJoinKey(href)
		const feature = key ? referenced.get(key) : undefined

		if (!feature) {
			if (!options.final) return "deferred"

			throw new UnresolvedComponentReferenceError(NL_KADASTER_ADAPTER_ID, addressID, href)
		}

		if (feature.type === "ad:ThoroughfareName") {
			street = feature.name
		} else if (feature.type === "ad:AddressAreaName") {
			locality = feature.name
		}

		// An `ad:AdminUnitName` reference resolves and contributes no component.
		// The one feature of that type in the document is the country, and its `ad:level`
		// reads `1stOrder` while the reference's position states no level at all.
	}

	if (!locality) return undefined

	const byType = designatorsByType(address)
	const house = dutchHouseNumber(byType)
	const postcode = designator(byType, "postalDeliveryIdentifier")

	if (!street && !postcode) return undefined

	const components: CanonicalRow["components"] = {}

	if (house) {
		components.house_number = house
	}

	if (street) {
		components.street = street
	}

	if (postcode) {
		components.postcode = postcode
	}

	components.locality = locality

	const rendered = formatAddressRow(components, "NL", { singleLine: true })

	if (!rendered) return undefined

	const { raw, components: aligned } = rendered

	return {
		raw,
		components: aligned,
		country: "NL",
		locale: "nl-NL",
		source: NL_KADASTER_ADAPTER_ID,
		source_id: addressID ? `${NL_KADASTER_ADAPTER_ID}-${addressID}` : stableSourceID(NL_KADASTER_ADAPTER_ID, aligned),
		corpus_version: "",
		license: NL_KADASTER_DEFAULT_LICENSE,
	}
}

/**
 * The document's bytes, inflated when the path ends in `.gz`.
 *
 * The publisher serves `.gml.gz` and no acquisition step inflates it on the way in,
 * so a caller hands the adapter the download as it arrived.
 * A plain `.gml` is read as well, and the committed fixture is one.
 *
 * The bytes a reviewer reads in the diff are therefore the bytes the test parses.
 */
function documentChunks(documentPath: PathBuilderLike): AsyncIterable<Uint8Array | string> {
	const path = PathBuilder.from(documentPath)
	const bytes = openReadStream(path)

	return path.basename().toLowerCase().endsWith(".gz") ? gunzipChunks(bytes) : bytes
}

/**
 * Every document under `inputPath`, where `inputPath` is one GML file or a directory holding them.
 *
 * A directory is read because the download is one national file today and the
 * service document could list more than one entry tomorrow.
 * A directory holding no document raises rather than yielding zero rows, so a wrong
 * path reports itself instead of reading as an empty publisher.
 */
async function documentPaths(inputPath: PathBuilderLike): Promise<readonly PathBuilderLike[]> {
	const path = PathBuilder.from(inputPath)
	const basename = path.basename().toLowerCase()

	if (basename.endsWith(".gml") || basename.endsWith(".gml.gz") || basename.endsWith(".xml")) return [path]

	const names = await Globerator.from("*.{gml,gml.gz,xml}", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${NL_KADASTER_ADAPTER_ID} adapter: ${path.toString()} holds no GML document`)
	}

	return names.map((name) => path(name))
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const nlKadasterAdapter = createNLKadasterAdapter()
