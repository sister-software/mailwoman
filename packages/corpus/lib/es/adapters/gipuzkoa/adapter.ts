/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `es-gipuzkoa`: the INSPIRE Addresses theme the Diputación Foral de Gipuzkoa publishes, read from
 * the one zipped GML that holds the whole province.
 *
 * The ATOM service at `https://b5m.gipuzkoa.eus/inspire/download/addresses.xml` holds a single entry
 * for the province and links its dataset through `rel="alternate"` rather than `rel="enclosure"`, so
 * a fetcher that looks only for an enclosure finds no dataset here. The adapter is handed the
 * archive and the feed is acquisition's concern. The archive holds one 313 MB GML member. The
 * adapter reads that member as a chunk sequence and never buffers it.
 *
 * The member is self-contained and its order decides the reader. Addresses number 68,744, and the
 * 4,516 reference features they point at are written last. An address held until the document ends
 * would keep all 68,744 pending, so the adapter reads the member twice through
 * {@linkcode streamIndexedInspireRows} and indexes the 4,516 references instead.
 *
 * A reference is a WFS stored-query URL whose `ID` parameter equals the target's `gml:id`, written
 * against the internal host `http://b5mdev/` and with the id repeated as the URL's fragment:
 * `…?…&ID=ES.GFA.TN.056.1110#ES.GFA.TN.056.1110`. `componentJoinKey` reads the parameter and the
 * fragment belongs to the URL rather than to the id, so the key is `ES.GFA.TN.056.1110`. The
 * unreachable host is not this reader's problem, because every reference resolves inside the member.
 *
 * A postal-descriptor reference whose final segment is empty, `…&ID=ES.GFA.PD.059. #…`, states that
 * the publisher holds no postcode, and `referenceStatesNoValue` separates it from a broken join.
 * The Cadastre writes the same form. The predicate therefore has one home.
 *
 * The locator vocabulary is one type,
 * `LocatorDesignatorTypeValue/addressIdentifierGeneral`. The municipality is the only
 * `ad:AdminUnitName` level published, `4thOrder`.
 *
 * The publisher writes its street names in Basque, with the street type as a trailing word rather
 * than a leading abbreviation: `Samikolla ibilbidea`. The name is taken as written.
 *
 * `ad:LocatorName` holds a building name as a Basque and Spanish pair, `Gasolinera` with
 * `Gasolindegia` and `Agirre, baserria` with `Agirre, caserío`. The adapter writes none of them: the
 * address-source register's personal-data review reads `absent` because these identify the building
 * rather than its occupant, and a Basque *baserri* name is commonly also a surname. The review
 * therefore does not rest on the stronger claim that the name is safe to publish as address text.
 *
 * The address `gml:id` `ES.GFA.AD.056_1110_003` concatenates the municipality code `056`, the
 * thoroughfare code `1110` and the number `003`, and holds references
 * `AU_ADMINISTRATIVEUNIT_34162020056`, `ES.GFA.TN.056.1110` and `ES.GFA.PD.056.20830`. The
 * adapter's test checks the composed street and number against that identifier. That check confirms
 * the right features were joined. It does not check the address the publisher would print.
 */

import type { MarkupElement } from "@mailwoman/core/html/elements"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { cadastralRow, referenceStatesNoValue, spanishHouseNumber } from "#es/cadastre"
import {
	adminUnitLevel,
	componentHrefs,
	componentJoinKey,
	designatorsByType,
	inspireNameIs,
	placeName,
	postalDescriptorCode,
	thoroughfareName,
	voidDesignatorTypes,
} from "#inspire/address"
import { inspireGMLChunks } from "#inspire/archive"
import { UnresolvedComponentReferenceError, VoidDesignatorError } from "#inspire/errors"
import { streamIndexedInspireRows } from "#inspire/stream"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const ES_GIPUZKOA_ADAPTER_ID = "es-gipuzkoa"

/**
 * The jurisdiction this adapter emits.
 *
 * Coverage is the province of Gipuzkoa.
 * The feed states that as the dataset's whole extent.
 */
export const ES_GIPUZKOA_COUNTRIES: readonly string[] = ["ES"]

/**
 * The license the address-source register elected for this publisher.
 *
 * Gipuzkoa states four things, and the register elects the one addressing this dataset:
 * the `otherConstraints` of its ISO 19139 dataset record, `CC BY-SA 4.0`.
 * Its feed states attribution only and its website states CC BY 4.0, and the register records
 * why the stricter reading is the one to err towards: the share-alike filter reads this label,
 * so recording CC BY 4.0 would hide an obligation the publisher may hold.
 *
 * The value is the SPDX identifier the register elected rather than the license's title,
 * because `licenseVerdict` resolves an identifier and reads a title as unrecognized.
 * Under `LicensePolicy.ShareAlikeFree` the title returns `{refusal: null, mentionsShareAlike: false}`
 * and `CC-BY-SA-4.0` returns a share-alike refusal, so the title admits these rows
 * to a corpus assembled to hold no share-alike source.
 */
export const ES_GIPUZKOA_LICENSE = "CC-BY-SA-4.0"

/**
 * The member of the archive that holds the GML.
 *
 * The archive ships one member, so the extension selects it without the adapter naming it.
 */
const GML_MEMBER = /\.gml$/iu

/**
 * The feature types an address references, indexed in the first pass over the member.
 *
 * `ad:AddressAreaName` is listed although the province publishes none, because the schema admits one
 * and a future edition that wrote one would otherwise read as an unresolved reference.
 */
const COMPONENT_ELEMENTS = [
	"ad:ThoroughfareName",
	"ad:PostalDescriptor",
	"ad:AdminUnitName",
	"ad:AddressAreaName",
] as const

/**
 * The administrative level that is the municipality.
 *
 * The only level the province publishes, on 88 of 88 `ad:AdminUnitName` features.
 */
const MUNICIPALITY_LEVEL = "4thOrder"

/**
 * The designator type the publisher writes.
 */
const HOUSE_NUMBER_TYPE = "addressIdentifierGeneral"

export function createESGipuzkoaAdapter(): CorpusAdapter {
	return {
		id: ES_GIPUZKOA_ADAPTER_ID,
		defaultLicense: ES_GIPUZKOA_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.GipuzkoaInspireAddresses,
		surface: SurfaceOrigin.Rendered,
		description:
			"INSPIRE Addresses (Diputación Foral de Gipuzkoa): house-number-level addresses for the province, as one zipped GML.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !ES_GIPUZKOA_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(ES_GIPUZKOA_ADAPTER_ID, ES_GIPUZKOA_COUNTRIES, opts.country)
			}

			let emitted = 0

			for (const archivePath of await archivePaths(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				for await (const row of streamIndexedInspireRows<MarkupElement>({
					chunks: () => inspireGMLChunks(archivePath, GML_MEMBER),
					componentElements: COMPONENT_ELEMENTS,
					index: (feature) => feature,
					compose: composeRow,
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
 * One address's row, or undefined when it holds too little to render.
 *
 * The reference index is complete before this is called, so a reference resolving to no
 * feature is a value the reader asked for and could not read, and it raises.
 */
function composeRow(address: MarkupElement, referenced: ReadonlyMap<string, MarkupElement>): CanonicalRow | undefined {
	const addressID = address.attributes["gml:id"]?.trim()

	if (voidDesignatorTypes(address).has(HOUSE_NUMBER_TYPE)) {
		throw new VoidDesignatorError(ES_GIPUZKOA_ADAPTER_ID, addressID, HOUSE_NUMBER_TYPE)
	}

	let street: string | undefined
	let postcode: string | undefined
	let locality: string | undefined
	let settlement: string | undefined

	for (const href of componentHrefs(address)) {
		const key = componentJoinKey(href)

		if (key && referenceStatesNoValue(key)) continue

		const feature = key ? referenced.get(key) : undefined

		if (!feature) throw new UnresolvedComponentReferenceError(ES_GIPUZKOA_ADAPTER_ID, addressID, href)

		const name = feature.name

		if (inspireNameIs(name, "ad:ThoroughfareName")) {
			street = thoroughfareName(feature)
		} else if (inspireNameIs(name, "ad:PostalDescriptor")) {
			postcode = postalDescriptorCode(feature)
		} else if (inspireNameIs(name, "ad:AddressAreaName")) {
			settlement = placeName(feature)
		} else if (inspireNameIs(name, "ad:AdminUnitName") && adminUnitLevel(feature) === MUNICIPALITY_LEVEL) {
			locality = placeName(feature)
		}
	}

	return cadastralRow(
		{
			street,
			house: spanishHouseNumber(designatorsByType(address), HOUSE_NUMBER_TYPE),
			postcode,
			locality,
			settlement,
			addressID,
		},
		{ adapterID: ES_GIPUZKOA_ADAPTER_ID, license: ES_GIPUZKOA_LICENSE }
	)
}

/**
 * Every archive under `inputPath`, which is one `.zip`, one unpacked `.gml`, or a directory holding either.
 *
 * The publisher ships one archive, and the unpacked member is accepted because an
 * operator who inflated 313,162,472 bytes once should not have to inflate them again,
 * and because a committed fixture is reviewable only as text.
 * A directory holding neither raises rather than yielding zero rows, so a wrong path
 * reports itself instead of reading as an empty publisher.
 */
async function archivePaths(inputPath: PathBuilderLike): Promise<readonly PathBuilderLike[]> {
	const path = PathBuilder.from(inputPath)
	const basename = path.basename().toLowerCase()

	if (basename.endsWith(".zip") || basename.endsWith(".gml")) return [path]

	const names = await Globerator.from("*.{zip,gml}", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${ES_GIPUZKOA_ADAPTER_ID} adapter: ${path.toString()} holds no .zip archive or .gml member`)
	}

	return names.map((name) => path(name))
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const esGipuzkoaAdapter = createESGipuzkoaAdapter()
