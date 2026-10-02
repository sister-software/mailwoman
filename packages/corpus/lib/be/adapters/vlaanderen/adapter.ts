/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `vlaanderen`: the INSPIRE Addresses (AD) theme of agentschap Digitaal Vlaanderen, read from a
 * local harvest of its WFS 2.0 download service at `https://geo.api.vlaanderen.be/ad/wfs`.
 *
 * Coverage is the Flemish Region rather than Belgium. Brussels and Wallonia publish the same theme
 * through their own services, so this adapter emits `BE` on every row it yields, and a Belgian build needs
 * two more sources beside it.
 *
 * The schema-level reading is `#inspire/address`, which owns every part of an `ad:Address` that the
 * publishers spell alike. This module holds only what is Flanders' own: the `resourceId` rewrite its
 * references need, the homonym discriminator its street names carry, and the lost characters its
 * values carry.
 *
 * The adapter records `Modellicentie voor gratis hergebruik Vlaanderen` on every row, the terms the
 * address-source register elects for `be-property-building-1` in `electedTerms`. Article 3 grants
 * reproduction, adaptation and commercial exploitation for any lawful purpose. Article 4 makes
 * attribution the only condition, in the form the licensor specifies, so the model card must carry
 * `Bron: Digitaal Vlaanderen`.
 *
 * The capabilities document's `ows:Fees` and `ows:AccessConstraints` state what calling the service
 * costs and who may call it. They describe the service rather than licensing the data, so the
 * licence comes from the register and this adapter reads the capabilities for feature types alone.
 *
 * ## Why the input is a harvest rather than the service
 *
 * An `ad:Address` carries its house number inline and everything else by reference. Each address
 * holds exactly four `ad:component/@xlink:href` values, measured over 1,000 addresses at six
 * `startIndex` offsets with all four prefixes occurring 1,000 times each. The references are
 * absolute URIs that resolve back into the same service under the `resourceId` rewrite that
 * {@linkcode componentResourceID} performs:
 *
 * | reference                                          | `resourceId`         | feature type          |
 * | -------------------------------------------------- | -------------------- | --------------------- |
 * | `https://data.vlaanderen.be/id/straatnaam/205827`  | `straatnaam_205827`  | `ad:ThoroughfareName` |
 * | `https://data.vlaanderen.be/id/postinfo/9800`      | `postinfo_9800`      | `ad:PostalDescriptor` |
 * | `https://data.vlaanderen.be/id/gemeentenaam/44083` | `gemeentenaam_44083` | `ad:AdminUnitName`    |
 * | `http://vocab.belgif.be/auth/refnis1995/1000#id`   | `refnis1995_1000`    | `ad:AdminUnitName`    |
 *
 * Resolving per address would cost four requests per row against 4,563,062 addresses. The component
 * types are small — 167,218 thoroughfare names, 1,190 postal descriptors, 609 administrative-unit
 * names — so the harvest takes each component type whole and the adapter joins locally.
 *
 * `ad:AddressRepresentation` is the one denormalized type, carrying street, postcode and post name
 * inline, and it cannot be harvested: any `startIndex`, `startIndex=0` included, answers HTTP 400
 * `ows:ExceptionCode/NoApplicableCode` with `java.lang.RuntimeException: Failed to get property:
 * {http://www.opengis.net/wfs/2.0}boundedBy`, and `resultType=hits` answers HTTP 504. Only its
 * unindexed first page works.
 *
 * ## What the harvest records, and why it has to
 *
 * `sortBy=gml:identifier` answers HTTP 504, so no stable ordering can be requested and a paged
 * harvest has no ordering guarantee. Two harvests may hold the same addresses in a different order.
 * The harvest manifest lists its pages and the adapter reads them in that listed order, so one
 * harvest reproduces its own bytes even though a second harvest need not match it.
 *
 * A bare `resultType=hits` answers `numberMatched="10000"` and stays there under `count=1000000`:
 * that is a per-request cap rather than a count. The same request with `startIndex=1` answers
 * `numberMatched="4563062"`, which agrees with the bisected tail — `startIndex=4563061` returns one
 * feature and `startIndex=4563062` returns none. Every results page reports
 * `numberMatched="unknown"`. Page size caps at 10,000, so a full harvest is 457 pages.
 *
 * The adapter honors `opts.limit` and `opts.signal`, and refuses any `opts.country` but `BE`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { type MarkupElement, streamMarkupElements } from "@mailwoman/core/html/elements"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder } from "path-ts"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { composeHouseNumber } from "#adapters/street-line"
import {
	adminUnitLevel,
	componentHrefs,
	designator,
	designatorsByType,
	placeName,
	postalDescriptorCode,
	thoroughfareName,
} from "#inspire/address"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const VLAANDEREN_ADAPTER_ID = "vlaanderen"

/**
 * The terms the address-source register elects for `be-property-building-1`.
 *
 * The value is the register's `electedTerms` for license
 * `unchecked-access-free-be-agentschap-digitaal-vlaanderen`, which carries no `spdx`,
 * so `electedLicenseLabel` answers this string and the share-alike prefix filter matches it.
 */
export const VLAANDEREN_DEFAULT_LICENSE = "Modellicentie voor gratis hergebruik Vlaanderen"

/**
 * The one jurisdiction this adapter emits.
 *
 * The service publishes the Flemish Region.
 * ISO 3166-1 assigns that region no code of its own, so its own, so the set holds one code
 * and a caller naming any other gets {@linkcode UnsupportedCountryError} rather than zero rows.
 */
export const VLAANDEREN_COUNTRIES: readonly string[] = ["BE"]

/**
 * The designator type Flanders writes its house number under.
 *
 * `ad:LocatorDesignator` repeats and is typed, so the number is selected by this term
 * rather than by position.
 * Flanders uses one type across 1,000 addresses sampled.
 *
 * Czechia and Brussels write `buildingIdentifier` and the Netherlands `addressNumber` for
 * the same part, which is why `#inspire/address` leaves the vocabulary to the caller.
 */
const HOUSE_NUMBER_DESIGNATOR = "addressIdentifierGeneral"

/**
 * The `ad:level` of the administrative unit that carries the municipality name.
 *
 * An address references two `ad:AdminUnitName` features.
 * `gemeentenaam_44083` is `5thOrder` and resolves to the municipality `Deinze`.
 *
 * `refnis1995_1000` is `1stOrder` and resolves to the country (`België`).
 * Taking whichever arrives first would write `België` into the `locality` of some rows.
 */
const MUNICIPALITY_LEVEL = "5thOrder"

/**
 * The marker Flanders writes where it lost a non-ASCII character.
 *
 * The loss is upstream of the service rather than in transport.
 * `postinfo_1007` answers `Assembl?e de la Commission Communautaire Fran?aise` in a document
 * declaring `encoding="UTF-8"`, and every advertised output format answers the same bytes:
 * `application/gml+xml; version=3.2` and `application/json` both serve `Rue du Ch?teau_`
 * for `straatnaam_138007`, with zero bytes above 0x7F in either body.
 *
 * Measured over 20,000 `ad:ThoroughfareName` values at twenty offsets,
 * 1,657 carry a `?` and 0 carry any non-ASCII character.
 * `ad:AdminUnitName` carries 34 of 609 and `ad:PostalDescriptor` 161 of 1,189 — and `ad:AdminUnitName`
 * also serves `België` intact, so the loss is per-value rather than a service-wide transcode.
 *
 * No address component is written with a question mark, so a value holding one
 * is a byte the publisher cannot supply.
 * The adapter refuses such a row and counts it, rather than emitting `Rue du Ch?teau`,
 * which would teach the model that `?` is a letter.
 */
const LOST_CHARACTER = "?"

/**
 * The components an address references, keyed by `resourceId`.
 */
interface ComponentIndex {
	/**
	 * `ad:ThoroughfareName` → the street name as the publisher spells it, discriminator included.
	 */
	streets: ReadonlyMap<string, string>
	/**
	 * `ad:PostalDescriptor` → its `ad:postCode`.
	 */
	postcodes: ReadonlyMap<string, string>
	/**
	 * `ad:AdminUnitName` at {@link MUNICIPALITY_LEVEL} → the municipality name.
	 *
	 * A unit at another level is left out, so a country-level reference cannot answer for a locality.
	 */
	municipalities: ReadonlyMap<string, string>
}

/**
 * What a harvest of the service holds, written beside its GML by the harvester.
 *
 * The manifest exists because the service grants no ordering: it records which pages were taken and in
 * which order, so the adapter's output is a function of the harvest rather than of a directory listing.
 */
export interface VlaanderenHarvest {
	/**
	 * The service the pages came from.
	 */
	service: string
	/**
	 * The WFS version the harvester spoke.
	 */
	wfsVersion: string
	/**
	 * The `outputFormat` the pages are written in.
	 */
	outputFormat: string
	/**
	 * When the harvest ran, as the service's own `timeStamp` reported it.
	 */
	retrievedAt: string
	/**
	 * The `numberMatched` the service reported for `ad:Address` past index 0.
	 */
	addressCount: number
	/**
	 * The files holding each component feature type, in the order the adapter reads them.
	 *
	 * A list rather than one file per type, because page size caps at 10,000
	 * and `ad:ThoroughfareName` holds 167,218 features: the type needs 17 pages.
	 * `ad:PostalDescriptor` (1,190) and `ad:AdminUnitName` (609) each fit in one,
	 * and are still listed, so a type that grows past the cap needs no change here.
	 */
	components: {
		ThoroughfareName: readonly string[]
		PostalDescriptor: readonly string[]
		AdminUnitName: readonly string[]
	}
	/**
	 * The address pages, in the order the adapter reads them.
	 */
	addressPages: readonly {
		startIndex: number
		file: string
		/**
		 * The `numberReturned` the page's own root element states.
		 *
		 * The adapter checks the features it parsed against this, so a truncated page raises
		 * rather than reading as a short one.
		 */
		numberReturned: number
	}[]
}

/**
 * Raised when the harvest cannot answer what the adapter asked it for.
 *
 * A harvest missing a component file or holding a short page cannot be read as a smaller
 * harvest: every address references all four components, so an absent component file
 * turns every row into a row with no street rather than into fewer rows.
 */
export class VlaanderenHarvestError extends Error {
	constructor(message: string) {
		super(`${VLAANDEREN_ADAPTER_ID} adapter: ${message}`)

		this.name = "VlaanderenHarvestError"
	}
}

/**
 * The `resourceId` that a component reference addresses in the same service.
 *
 * Flanders writes an absolute identifier URI rather than the local `#` fragment that
 * the Netherlands, Wallonia and Brussels write, and the service answers it under the
 * `gml:id` built from the URI's last two path segments joined with `_`.
 * A fragment is dropped, because `…/refnis1995/1000#id` addresses `refnis1995_1000`.
 *
 * @returns The id, or `null` when the href is not a URL with at least two path segments.
 * A caller treats `null` as a reference it could not read rather than as a
 * reference the publisher left blank.
 */
export function componentResourceID(href: string): string | null {
	let url: URL

	try {
		url = new URL(href)
	} catch {
		return null
	}

	const segments = url.pathname.split("/").filter((segment) => segment.length > 0)

	if (segments.length < 2) return null

	return `${segments.at(-2)}_${segments.at(-1)}`
}

/**
 * A Flemish street name read apart from the homonym discriminator that follows it.
 *
 * `gn:text` on an `ad:ThoroughfareName` is not the street name alone: it is the name,
 * an underscore, and a discriminator that is usually empty.
 * Over 20,000 values at twenty offsets, 19,979 end with `_` and the remaining 21 carry a
 * discriminator after it — `Rue de Cronwez_01`, `Rue de Cronwez_02`, `Heide_01`, `Heide_02`,
 * `Kattenberg_BO`, `Kattenberg_EK`, `Ringlaan_ME`, `Ringlaan_BEWI`, `Berkenlaan_WI`,
 * `Weerstandlaan_BO`, `Weerstandlaan_HO`, `Cit? du Repos_01` through `_04`, `Rue du Roeulx_01`,
 * `Rue du Roeulx_02`, `Rue Verte_01`, `Rue Verte_02` and `Rue des Par?onniers_01`/`_02`.
 *
 * Exactly 21 values carry an `_` anywhere but at the end, and they are the same 21: no value holds
 * both a discriminator and a trailing separator, so the field is one separator at one position.
 *
 * The same streets read through `ad:AddressRepresentation/ad:thoroughfare` carry
 * no separator at all, 0 of 10,000, which is the publisher's own evidence that
 * everything from the `_` onward is bookkeeping rather than name.
 *
 * So the split takes the last `_` and keeps the head.
 * Stripping only a trailing `_` would leave `Rue de Cronwez_01` in a corpus,
 * and keeping the whole value would leave `Acacialaan_`.
 */
export interface SplitStreetName {
	/**
	 * The street name, with the separator and any discriminator removed.
	 */
	street: string
	/**
	 * The homonym discriminator, empty for all but 21 of the 20,000 values measured.
	 */
	discriminator: string
}

/**
 * Splits an `ad:ThoroughfareName` `gn:text` value into its {@link SplitStreetName}.
 *
 * @throws {@linkcode VlaanderenHarvestError} when the value carries no `_`,
 * which no value of the 20,000 measured did.
 * That is a change in the publisher's field rather than an odd street, and guessing at
 * it would write a bookkeeping suffix into every row sharing the new shape.
 */
export function splitStreetName(value: string): SplitStreetName {
	const separator = value.lastIndexOf("_")

	if (separator === -1) {
		throw new VlaanderenHarvestError(
			`the thoroughfare name ${stringifyJSON(value)} carries no "_" separator. ` +
				`Every one of 20,000 values measured over twenty offsets carries exactly one, so the field's ` +
				`shape has changed and the name cannot be read apart from its discriminator.`
		)
	}

	return { street: value.slice(0, separator).trim(), discriminator: value.slice(separator + 1).trim() }
}

/**
 * The house number an address states inline, or `undefined` when it states none this adapter can use.
 *
 * `designatorsByType` skips a designator the publisher marked void, so a void number
 * and an absent one both answer `undefined` here.
 * Both are refusals rather than addresses with no number, and the caller counts
 * them together for that reason.
 *
 * `ad:designator` was present and populated on 1,000 of 1,000 addresses sampled,
 * so neither condition has been seen on this service.
 */
export function houseNumberOf(address: MarkupElement): string | undefined {
	return designator(designatorsByType(address), HOUSE_NUMBER_DESIGNATOR)
}

/**
 * Reads one component feature type whole and indexes it by `resourceId`.
 */
async function readComponentFiles<T>(
	root: PathBuilder,
	files: readonly string[],
	typeName: string,
	read: (feature: MarkupElement) => T | undefined,
	signal?: AbortSignal
): Promise<Map<string, T>> {
	const index = new Map<string, T>()

	for (const file of files) {
		const filePath = root(file)

		for await (const feature of streamMarkupElements(openReadStream(filePath), typeName, { xml: true, signal })) {
			// The service answers a reference by the `gml:id` built from its URI's last two segments,
			// so a feature's own `gml:id` is the key `componentResourceID` produces for it.
			const id = feature.attributes["gml:id"]

			if (!id) {
				throw new VlaanderenHarvestError(
					`a ${typeName} feature in ${filePath.toString()} carries no gml:id, so nothing can reference it`
				)
			}

			const value = read(feature)

			if (value !== undefined) {
				index.set(id, value)
			}
		}
	}

	return index
}

/**
 * Loads the three component types a harvest holds.
 */
async function readComponentIndex(
	root: PathBuilder,
	harvest: VlaanderenHarvest,
	signal?: AbortSignal
): Promise<ComponentIndex> {
	const streets = await readComponentFiles(
		root,
		harvest.components.ThoroughfareName,
		"ad:ThoroughfareName",
		thoroughfareName,
		signal
	)

	const postcodes = await readComponentFiles(
		root,
		harvest.components.PostalDescriptor,
		"ad:PostalDescriptor",
		// `ad:postName` is deliberately unread.
		// For 9800 it holds `Astene/Bachte-Maria-Leerne/DEINZE/…`, eleven names under one code,
		// so it lists the places a code serves rather than a locality.
		// The locality comes from `ad:AdminUnitName`.
		postalDescriptorCode,
		signal
	)

	const municipalities = await readComponentFiles(
		root,
		harvest.components.AdminUnitName,
		"ad:AdminUnitName",
		(feature) => (adminUnitLevel(feature) === MUNICIPALITY_LEVEL ? placeName(feature) : undefined),
		signal
	)

	for (const [typeName, index] of [
		["ad:ThoroughfareName", streets],
		["ad:PostalDescriptor", postcodes],
		["ad:AdminUnitName", municipalities],
	] as const) {
		// An aborted read stopped mid-file, so an empty index states that the caller cancelled
		// rather than that the harvest is incomplete.
		if (signal?.aborted) break

		if (!index.size) {
			throw new VlaanderenHarvestError(
				`the harvest's ${typeName} file holds no feature this adapter can join. Every address ` +
					`references all four component types, so an empty index turns every row into a row with ` +
					`no street rather than into fewer rows.`
			)
		}
	}

	return { streets, postcodes, municipalities }
}

/**
 * Reads the harvest manifest and checks that it names what the adapter needs.
 */
export async function readVlaanderenHarvest(root: PathBuilder): Promise<VlaanderenHarvest> {
	const manifestPath = root("harvest.json")
	const harvest = await readLocalJSONFile<VlaanderenHarvest>(manifestPath)
	const components = harvest.components

	if (
		!components?.ThoroughfareName?.length ||
		!components.PostalDescriptor?.length ||
		!components.AdminUnitName?.length
	) {
		throw new VlaanderenHarvestError(
			`${manifestPath.toString()} names no file for one of ad:ThoroughfareName, ad:PostalDescriptor ` +
				`and ad:AdminUnitName. All three are needed, because an address carries its street, postcode ` +
				`and locality only by reference.`
		)
	}

	if (!Array.isArray(harvest.addressPages) || !harvest.addressPages.length) {
		throw new VlaanderenHarvestError(`${manifestPath.toString()} lists no address page`)
	}

	return harvest
}

/**
 * What the adapter refused, counted by reason.
 *
 * Each count is reported rather than folded into the yield, so a run states what it dropped and why.
 */
interface Refusals {
	/**
	 * The publisher states no house number this adapter can use, void or absent.
	 */
	noHouseNumber: number
	/**
	 * A reference the harvest's component index cannot answer.
	 */
	unjoined: number
	/**
	 * A component value carrying {@link LOST_CHARACTER}.
	 */
	lostCharacter: number
	/**
	 * An address the codex could not render into a line.
	 */
	unrendered: number
}

export function createVlaanderenAdapter(): CorpusAdapter {
	return {
		id: VLAANDEREN_ADAPTER_ID,
		defaultLicense: VLAANDEREN_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.VlaanderenInspireAddresses,
		surface: SurfaceOrigin.Rendered,
		description:
			"INSPIRE Addresses (agentschap Digitaal Vlaanderen): house-number-level addresses for the Flemish Region.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !VLAANDEREN_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(VLAANDEREN_ADAPTER_ID, VLAANDEREN_COUNTRIES, opts.country)
			}

			// Checked before the harvest is opened, so a caller that cancelled first pays no read.
			if (opts.signal?.aborted) return

			const root = PathBuilder.from(opts.inputPath)
			const harvest = await readVlaanderenHarvest(root)
			const index = await readComponentIndex(root, harvest, opts.signal)

			let emitted = 0
			const refused: Refusals = { noHouseNumber: 0, unjoined: 0, lostCharacter: 0, unrendered: 0 }

			try {
				// The manifest's order is the read order, because the service grants none:
				// `sortBy=gml:identifier` answers HTTP 504.
				for (const page of harvest.addressPages) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const pagePath = root(page.file)
					let seen = 0

					for await (const address of streamMarkupElements(openReadStream(pagePath), "ad:Address", {
						xml: true,
						signal: opts.signal,
					})) {
						if (opts.signal?.aborted) break

						seen++

						if (opts.limit !== undefined && emitted >= opts.limit) break

						const house = houseNumberOf(address)

						if (house === undefined) {
							refused.noHouseNumber++

							continue
						}

						let street: string | undefined
						let postcode: string | undefined
						let locality: string | undefined
						let unreadable = false

						for (const href of componentHrefs(address)) {
							const id = componentResourceID(href)

							if (id === null) {
								unreadable = true

								break
							}

							const streetValue = index.streets.get(id)

							if (streetValue !== undefined) {
								street = streetValue

								continue
							}

							const postcodeValue = index.postcodes.get(id)

							if (postcodeValue !== undefined) {
								postcode = postcodeValue

								continue
							}

							// A country-level `ad:AdminUnitName` is indexed out, so `refnis1995_1000`
							// reaches here with no municipality and is not a defect.
							locality = index.municipalities.get(id) ?? locality
						}

						// A reference the harvest cannot answer is a street, postcode
						// or locality this run could not read.
						// Emitting the row without it would record an absence the publisher never stated.
						if (unreadable || street === undefined || postcode === undefined || locality === undefined) {
							refused.unjoined++

							continue
						}

						if (
							street.includes(LOST_CHARACTER) ||
							postcode.includes(LOST_CHARACTER) ||
							locality.includes(LOST_CHARACTER)
						) {
							refused.lostCharacter++

							continue
						}

						const rendered = formatAddressRow(
							{
								house_number: composeHouseNumber(house, ""),
								street: splitStreetName(street).street,
								postcode,
								locality,
							},
							"BE",
							{ singleLine: true }
						)

						if (!rendered) {
							refused.unrendered++

							continue
						}

						const { raw, components: aligned } = rendered
						// `gml:id` is `adres_<localId>`, unique within the service and stable across harvests.
						const seed = address.attributes["gml:id"] ?? ""

						yield {
							raw,
							components: aligned,
							country: "BE",
							// The service writes every component name in Dutch: `gn:language` reads
							// `nld` on each one, the French-facility street names included.
							locale: "nl-BE",
							source: VLAANDEREN_ADAPTER_ID,
							source_id: seed ? `${VLAANDEREN_ADAPTER_ID}-${seed}` : stableSourceID(VLAANDEREN_ADAPTER_ID, aligned),
							corpus_version: "",
							license: VLAANDEREN_DEFAULT_LICENSE,
						}

						emitted++
					}

					// A short page is a page this run could not read whole.
					// Reading it as a smaller page would drop its tail silently,
					// and a harvest of 457 pages hides one missing tail.
					const bounded = opts.limit !== undefined || Boolean(opts.signal?.aborted)

					if (!bounded && seen !== page.numberReturned) {
						throw new VlaanderenHarvestError(
							`${pagePath.toString()} holds ${seen} ad:Address features where the harvest records ` +
								`numberReturned=${page.numberReturned} for startIndex=${page.startIndex}`
						)
					}
				}
			} finally {
				const dropped = refused.noHouseNumber + refused.unjoined + refused.lostCharacter + refused.unrendered

				if (dropped > 0) {
					process.stderr.write(
						`  vlaanderen: ${emitted} rows kept, ${dropped} refused ` +
							`(${refused.lostCharacter} carry a lost character, ${refused.unjoined} hold a reference ` +
							`the harvest cannot answer, ${refused.noHouseNumber} state no house number, ` +
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
export const vlaanderenAdapter = createVlaanderenAdapter()
