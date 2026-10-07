/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `sk-inspire`: the INSPIRE Addresses theme the Slovak Ministry of the Interior publishes out of the
 * national address register, read from saved pages of its Web Feature Service.
 *
 * The service is `https://rageo.minv.sk/geoserver/ad/wfs`, a GeoServer WFS 2.0 that advertises
 * `ImplementsResultPaging` and serves all five AD feature types. Measured 2026-10-02, a
 * `GetFeature` for `ad:Address` answers `numberMatched="1704196"`, and the other four types hold
 * 29,315 `ad:ThoroughfareName`, 3,015 `ad:AdminUnitName`, 1,769 `ad:AddressAreaName` and 1,415
 * `ad:PostalDescriptor`. Acquisition pages each type into its own document and the adapter reads a
 * directory of those pages, so a build harvests the service once and reads the saved bytes.
 *
 * The reference form is a WFS stored-query URL: an `ad:component` href is
 * `…/ad/ows?…&storedQuery_id=urn:ogc:def:query:OGC-WFS::GetFeatureById&id=AdminUnitName.199`, and
 * that `id` parameter equals the target's `gml:id` exactly. A `GetFeatureById` fetch of
 * `AdminUnitName.199` confirms. `componentJoinKey` reads it. Each reference also repeats its target's
 * value in `xlink:title`, as Czechia's does, and the adapter reads none of those titles. Three of an
 * address's references are `ad:AdminUnitName` features whose titles are a region, a district and a
 * municipality, and only the resolved feature's `ad:level` separates the three.
 *
 * That is why the reader takes two passes over the input rather than one. A component page is a
 * different document from an address page, so a single pass would have to defer an address until the
 * page holding its municipality arrived, and with 1,704,196 addresses against 35,514 component
 * features the deferred list is the wrong side of the join to hold. The first pass indexes the four
 * component types from every document, and the second streams `ad:Address`. The index is therefore
 * complete before the first address is read, so a reference resolving to no feature is a value the
 * reader asked for and could not read, and it raises.
 *
 * The locator vocabulary is two types, and the publisher's own rendering fixes how they compose.
 * `ad:designator` repeats and states no position, so selection goes by `ad:type/@xlink:href`:
 * `addressNumber` is the *číslo popisné* and is present on every address, and `buildingIdentifier`
 * is the *orientačné číslo* and appears only where the address also references a street. Measured
 * over 1,000 addresses across ten windows spread through the 1,704,196, `addressNumber` appeared
 * 1,000 times, `buildingIdentifier` 334 times, and the street count was also exactly 334.
 *
 * The same publisher serves its register's own rendered address through `ra:address` on the same
 * GeoServer. That rendering pins the composition. Three records, matched by street, number and postcode:
 *
 * | `addressNumber` | `buildingIdentifier` | street | `fulladdress` |
 * | --- | --- | --- | --- |
 * | `1760` | `29` | `Lipová` | `Lipová,1760/29,Hurbanovo,94701` |
 * | `1771` | `4` | `Skalická` | `Skalická,1771/4,Košice-Krásna,04018` |
 * | `142` | (absent) | (absent) | `142,Sikenička,94359` |
 *
 * So the number is `addressNumber` by itself, or `addressNumber/buildingIdentifier` where the
 * orientation number exists. That is the publisher's own `annotation` field verbatim. A street-less
 * address is ordinary rather than a defect: 666 of those 1,000 referenced no `ad:ThoroughfareName`.
 *
 * The place names come from two types. `ad:AdminUnitName` at `4thOrder` is the municipality and is
 * referenced by every address measured, 1,080 of 1,080. The `3rdOrder` district and the `2ndOrder`
 * region are referenced beside it and are not part of a written address. `ad:AddressAreaName` is the
 * *časť obce*, the settlement part, and 426 of those 1,080 addresses reference one. Of those 426, 325
 * repeat the municipality and 101 state another place, such as `Lidér Tejed` in the municipality
 * of `Povoda`, so the adapter writes a dependent locality only where the two differ. The publisher's
 * own `fulladdress` omits the settlement part in both cases, so a row holding one states a component
 * that string does not.
 *
 * The postcode is `ad:PostalDescriptor/ad:postCode`, written as five digits with its leading zero
 * intact (`04018`). Slovak usage splits it as `040 18`. The publisher writes it closed up, and the
 * row stores what the publisher wrote, as the Czech reader does with `66463`.
 *
 * The Ministry states one condition of use and states it twice, in its own register record
 * `https://rpi.gov.sk/api/collection_record/86dea70e-a55b-4241-bd63-4024b3f76b72` and in that
 * record's INSPIRE export: `Neuplatňujú sa žiadne podmienky (CC0 Voľné dielo)`. That phrase renders
 * INSPIRE's controlled value for no conditions applying to access and use, in Slovak, with the
 * publisher's own identification of it as CC0. No version accompanies the label, so the
 * address-source register writes no SPDX identifier and the rows record the publisher's words.
 *
 * The adapter honors `opts.limit` and `opts.signal`. `opts.country` is optional and accepts only `SK`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { streamMarkupElements, type MarkupElement } from "@mailwoman/core/html/elements"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

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
import { UnresolvedComponentReferenceError, VoidDesignatorError } from "#inspire/errors"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const SK_INSPIRE_ADAPTER_ID = "sk-inspire"

/**
 * The publication this adapter reads.
 *
 * The literal stands in for a `SourceRegister` member until `lib/registers.ts` declares
 * `SlovakiaInspireAddresses: "sk-minv-inspire-ad"`, which is the id this value spells.
 */
export const SK_INSPIRE_REGISTER = SourceRegister.SlovakiaInspireAddresses

/**
 * The one jurisdiction this adapter emits.
 *
 * The service's register record states a national spatial scope with a `footprint_geo`
 * of `Slovenská Republika`, so the set has one member.
 */
export const SK_INSPIRE_COUNTRIES: readonly string[] = ["SK"]

/**
 * The license the address-source register elected for this publisher.
 *
 * `unchecked-access-free-sk-ministerstvo-vn-tra-slovenskej-republiky` is elected with
 * `electedTerms` `Neuplatňujú sa žiadne podmienky (CC0 Voľné dielo)` and no `spdx`,
 * because the publisher names CC0 without a version.
 * The rows therefore record the publisher's own words, as Poland's and Czechia's do.
 */
export const SK_INSPIRE_DEFAULT_LICENSE = "Neuplatňujú sa žiadne podmienky (CC0 Voľné dielo)"

/**
 * The four feature types an address references, read in the first pass.
 */
const COMPONENT_TYPES = [
	"ad:ThoroughfareName",
	"ad:AddressAreaName",
	"ad:AdminUnitName",
	"ad:PostalDescriptor",
] as const

/**
 * The administrative level that is the municipality.
 *
 * Measured over 1,080 addresses, every one references exactly one `ad:AdminUnitName` at this level.
 * The `3rdOrder` district and the `2ndOrder` region are referenced beside it, so the level
 * rather than the reference's position picks the municipality.
 */
const MUNICIPALITY_LEVEL = "4thOrder"

/**
 * What one referenced feature contributes to an address.
 *
 * A value rather than the feature's subtree, because the four component types hold
 * 35,514 features and the index is held for the whole of the second pass.
 */
interface ReferencedValue {
	/**
	 * The feature's element name.
	 * It decides where its value goes.
	 */
	readonly type: string

	/**
	 * The street name, place name or postcode the feature states.
	 */
	readonly value?: string

	/**
	 * The administrative level an `ad:AdminUnitName` states, such as `4thOrder`.
	 */
	readonly level?: string
}

/**
 * The value a referenced feature contributes, read once as the feature arrives.
 */
function referencedValue(feature: MarkupElement): ReferencedValue {
	if (feature.name === "ad:ThoroughfareName") {
		return { type: feature.name, value: thoroughfareName(feature) }
	}

	if (feature.name === "ad:PostalDescriptor") {
		return { type: feature.name, value: postalDescriptorCode(feature) }
	}

	if (feature.name === "ad:AdminUnitName") {
		return { type: feature.name, value: placeName(feature), level: adminUnitLevel(feature) }
	}

	return { type: feature.name, value: placeName(feature) }
}

/**
 * The house number as the Register adries writes it in its own `annotation` field.
 *
 * The descriptive number is the whole value where the publisher states no orientation
 * number, and the two are joined by a solidus where it does.
 * The table in this module's header reads that off three records of the publisher's `ra:address` layer.
 *
 * @returns The number, or undefined when the publisher states no `addressNumber`.
 */
export function slovakHouseNumber(byType: ReadonlyMap<string, readonly string[]>): string | undefined {
	const descriptive = designator(byType, "addressNumber")

	if (!descriptive) return undefined

	const orientation = designator(byType, "buildingIdentifier")

	return orientation ? `${descriptive}/${orientation}` : descriptive
}

export function createSKInspireAdapter(): CorpusAdapter {
	return {
		id: SK_INSPIRE_ADAPTER_ID,
		defaultLicense: SK_INSPIRE_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SK_INSPIRE_REGISTER,
		surface: SurfaceOrigin.Rendered,
		description:
			"INSPIRE Addresses (Ministerstvo vnútra SR): house-number-level addresses for Slovakia, read from saved WFS pages.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !SK_INSPIRE_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(SK_INSPIRE_ADAPTER_ID, SK_INSPIRE_COUNTRIES, opts.country)
			}

			const documents = await documentPaths(opts.inputPath)
			/**
			 * The value of every referenced feature in the input, by its `gml:id`.
			 */
			const referenced = new Map<string, ReferencedValue>()

			for (const documentPath of documents) {
				if (opts.signal?.aborted) return

				for await (const feature of streamMarkupElements(documentChunks(documentPath), COMPONENT_TYPES, {
					xml: true,
				})) {
					if (opts.signal?.aborted) return

					const id = feature.attributes["gml:id"]

					if (id) {
						referenced.set(id, referencedValue(feature))
					}
				}
			}

			let emitted = 0

			for (const documentPath of documents) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				for await (const address of streamMarkupElements(documentChunks(documentPath), "ad:Address", {
					xml: true,
				})) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const row = composeRow(address, referenced)

					if (!row) continue

					yield row

					emitted++
				}
			}
		},
	}
}

/**
 * One address's row, or `undefined` when it holds too little to render.
 *
 * The component index is complete before this is called, so a reference that
 * resolves to no feature raises rather than being deferred.
 */
function composeRow(
	address: MarkupElement,
	referenced: ReadonlyMap<string, ReferencedValue>
): CanonicalRow | undefined {
	const addressID = address.attributes["gml:id"]?.trim()
	const voided = voidDesignatorTypes(address)

	for (const type of ["addressNumber", "buildingIdentifier"]) {
		if (voided.has(type)) throw new VoidDesignatorError(SK_INSPIRE_ADAPTER_ID, addressID, type)
	}

	let street: string | undefined
	let postcode: string | undefined
	let municipality: string | undefined
	let settlement: string | undefined

	for (const href of componentHrefs(address)) {
		const key = componentJoinKey(href)
		const feature = key ? referenced.get(key) : undefined

		if (!feature) throw new UnresolvedComponentReferenceError(SK_INSPIRE_ADAPTER_ID, addressID, href)

		if (feature.type === "ad:ThoroughfareName") {
			street = feature.value
		} else if (feature.type === "ad:PostalDescriptor") {
			postcode = feature.value
		} else if (feature.type === "ad:AddressAreaName") {
			settlement = feature.value
		} else if (feature.type === "ad:AdminUnitName" && feature.level === MUNICIPALITY_LEVEL) {
			municipality = feature.value
		}
	}

	const place = municipality ?? settlement

	if (!place) return undefined

	const components: CanonicalRow["components"] = {}
	const house = slovakHouseNumber(designatorsByType(address))

	if (house) {
		components.house_number = house
	}

	if (street) {
		components.street = street
	}

	// The settlement part is a dependent locality only where it differs from the
	// municipality. 101 of 426 address-area references do.
	if (settlement && municipality && settlement !== municipality) {
		components.dependent_locality = settlement
	}

	if (postcode) {
		components.postcode = postcode
	}

	components.locality = place

	const rendered = formatAddressRow(components, "SK", { singleLine: true })

	if (!rendered) return undefined

	const { raw, components: aligned } = rendered

	return {
		raw,
		components: aligned,
		country: "SK",
		locale: "sk-SK",
		source: SK_INSPIRE_ADAPTER_ID,
		source_id: addressID ? `${SK_INSPIRE_ADAPTER_ID}-${addressID}` : stableSourceID(SK_INSPIRE_ADAPTER_ID, aligned),
		corpus_version: "",
		license: SK_INSPIRE_DEFAULT_LICENSE,
	}
}

/**
 * One saved WFS page as the chunk sequence the markup reader takes.
 */
function documentChunks(documentPath: PathBuilderLike): AsyncIterable<Uint8Array | string> {
	return openReadStream(PathBuilder.from(documentPath))
}

/**
 * Every document under `inputPath`, which is one saved page or a directory holding them.
 *
 * A directory is the ordinary case, because the service publishes five feature types
 * and acquisition writes a document per type.
 * The walk is recursive, because `#sk/tools/fetch/inspire` gives each type its own
 * subdirectory so that each keeps its own harvest manifest.
 *
 * A directory holding no document raises rather than yielding zero rows, so a wrong
 * path reports itself instead of reading as an empty publisher.
 */
async function documentPaths(inputPath: PathBuilderLike): Promise<readonly PathBuilderLike[]> {
	const path = PathBuilder.from(inputPath)
	const basename = path.basename().toLowerCase()

	if (basename.endsWith(".gml") || basename.endsWith(".xml")) return [path]

	const names = await Globerator.from("**/*.{gml,xml}", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${SK_INSPIRE_ADAPTER_ID} adapter: ${path.toString()} holds no GML document`)
	}

	return names.map((name) => path(name))
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const skInspireAdapter = createSKInspireAdapter()
