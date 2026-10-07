/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `es-navarra`: the INSPIRE Addresses theme the Gobierno de Navarra publishes, read from its zipped
 * GML partitions.
 *
 * The ATOM service at
 * `https://filescartografia.navarra.es/2_CARTOGRAFIA_TEMATICA/2_7_CATASTRO/2_7_3_INSPIRE_ATOM/2_7_3_3_AD/Addresses_ServiceATOM_Navarra.xml`
 * is 671,131 bytes and splits the province across 272 entries. Every entry is titled `Address
 * Navarra`, and the feed states no place for a partition. The three measured each held one
 * municipality: partition 1 Abáigar, partition 100 Eulate and partition 250 Bera. The feed states
 * no such mapping and this adapter claims none. It reads one archive or a directory of them. A
 * caller harvests all 272 by pointing it at the directory.
 *
 * This publisher is read entirely from its references' titles, and that is what separates it from
 * every other INSPIRE reader here. Its own file publishes no `AD:ThoroughfareName`,
 * `AD:PostalDescriptor` or `AD:AdminUnitName` feature at all: partition 1 holds 29 distinct element
 * names across 115 addresses and none of them is a component feature. Each address instead holds
 * six `AD:component` references whose `xlink:title` states the value:
 *
 * | `xlink:href` | `xlink:title` | read as |
 * | --- | --- | --- |
 * | `…&ID=AD_ADMINUNITNAME_PAI_34000000000#…` | `España` | skipped |
 * | `…&ID=AD_ADMINUNITNAME_COM_34150000000#…` | `Comunidad Foral de Navarra` | skipped |
 * | `…&ID=AD_ADMINUNITNAME_MUN_34153131001#…` | `Abáigar` | the locality |
 * | `http://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/5thOrder` | `Abáigar` | the settlement |
 * | `ThoroughfareName` | `CALLE CALLEJA` | the street |
 * | `PostalDescriptor` | `31280` | the postcode |
 *
 * The counts are exact and regular: 690 references over 115 addresses in partition 1, 1,728 over 288
 * in partition 100 and 6,324 over 1,054 in partition 250. Each address holds six references, one of
 * each shape above.
 *
 * The two place titles are not the same value. In Abáigar and Eulate the `5thOrder` title repeats the
 * municipality, and in Bera it states a *concejo* the municipality contains: `Suspela` and `Dornaku`
 * beside `Bera`. The fifth order is below the municipal fourth, so the title is written as a
 * dependent locality where it differs from the municipality and left out where it repeats it.
 *
 * `Comunidad Foral de Navarra` is the autonomous community's own name rather than the province name a
 * Spanish address writes, and the publisher's own address layer has no region column, so no
 * `region` is written.
 *
 * The publisher's own rendering is in a different service, and it agrees. `IDENA` publishes
 * `IDENA:DIRECC_Txt_Direcciones`, 181,098 features, each with `MUNICIPIO`, `ENTIDAD`, `CODPOSTAL`,
 * `VIA` and `PORTAL`. Partition 1's `AD.Address.1` composes `CALLE CALLEJA, 4, 31280 Abáigar`, and
 * that layer's `DIRECC_Txt_Direcciones.1` reads `MUNICIPIO` `Abáigar`, `ENTIDAD` `Abáigar`,
 * `CODPOSTAL` `31280`, `VIA` `CALLE CALLEJA`, `PORTAL` `4`. The adapter's integration test checks a
 * sample of rows against that layer, the publisher-side oracle for this source.
 *
 * Two values state an absence rather than a value. A `PostalDescriptor` title of `0` is the publisher
 * holding no postcode, measured in Bera. A designator of `S/N` is *sin número*, and `#es/cadastre`
 * reads it for all four Spanish cadastres. A designator may also hold a space-separated letter,
 * `18 A` and `34 A` in Eulate. The adapter keeps that letter as the publisher wrote it.
 */

import { type MarkupElement, streamMarkupElements } from "@mailwoman/core/html/elements"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { cadastralRow, spanishHouseNumber } from "#es/cadastre"
import {
	codelistValue,
	componentJoinKey,
	componentLinks,
	designatorsByType,
	voidDesignatorTypes,
} from "#inspire/address"
import { inspireGMLChunks } from "#inspire/archive"
import { VoidDesignatorError } from "#inspire/errors"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const ES_NAVARRA_ADAPTER_ID = "es-navarra"

/**
 * The jurisdiction this adapter emits.
 */
export const ES_NAVARRA_COUNTRIES: readonly string[] = ["ES"]

/**
 * The license the address-source register elected for this publisher.
 *
 * Navarra states one license and states it in its own feed: the feed-level `rights` of
 * `Addresses_ServiceATOM_Navarra.xml` reads `This layer is published under the terms of the license
 * Creative Commons Attribution 4.0 International (CC BY 4.0)`, and all 272 of its entries repeat it.
 * The version is stated, so the register records `CC-BY-4.0` as the SPDX identifier.
 *
 * The row states that identifier rather than the license's title.
 * `licenseVerdict` resolves an identifier and reads a title as unrecognized.
 *
 * A row whose license resolves to no expression has unknown obligations rather than none.
 * The build reports that separately from a refusal.
 */
export const ES_NAVARRA_LICENSE = "CC-BY-4.0"

/**
 * The member of a partition's archive that holds the GML.
 *
 * Each archive ships one member, `AD_Navarra_<n>.gml`, so the extension selects
 * it without the adapter knowing the partition number.
 */
const GML_MEMBER = /\.gml$/iu

/**
 * The element each address is written as.
 *
 * The publisher binds the INSPIRE namespaces to upper-case prefixes.
 */
const ADDRESS_ELEMENT = "AD:Address"

/**
 * The designator type the publisher writes, on every address of the three partitions measured.
 */
const HOUSE_NUMBER_TYPE = "addressIdentifierGeneral"

/**
 * The reference href that states a street name in its title.
 */
const THOROUGHFARE_HREF = "thoroughfarename"

/**
 * The reference href that states a postcode in its title.
 */
const POSTAL_DESCRIPTOR_HREF = "postaldescriptor"

/**
 * The stored-query id prefix of the administrative-unit reference that is the municipality.
 *
 * The other two are `AD_ADMINUNITNAME_PAI_`, the country, and `AD_ADMINUNITNAME_COM_`,
 * the autonomous community, and neither belongs to a written address.
 */
const MUNICIPALITY_ID_PREFIX = "AD_ADMINUNITNAME_MUN_"

/**
 * The administrative level whose title is a settlement within the municipality.
 */
const SETTLEMENT_LEVEL = "5thOrder"

/**
 * The postcode title that states that the publisher holds none.
 *
 * Bera writes `0` beside its `31780`.
 */
const NO_POSTCODE_TITLE = "0"

/**
 * What one address's references state, read from their titles.
 */
interface ReferencedTitles {
	street?: string
	postcode?: string
	locality?: string
	settlement?: string
}

/**
 * The street, postcode and place names an address's own references state.
 *
 * Each reference is placed by its href rather than by its position, because the six are written in one
 * order in the three partitions measured and that order is the publisher's rather than the schema's.
 */
export function navarraReferencedTitles(address: MarkupElement): ReferencedTitles {
	const titles: ReferencedTitles = {}

	for (const { href, title } of componentLinks(address)) {
		if (!title) continue

		const lowered = href.toLowerCase()

		if (lowered === THOROUGHFARE_HREF) {
			titles.street = title
		} else if (lowered === POSTAL_DESCRIPTOR_HREF) {
			titles.postcode = title === NO_POSTCODE_TITLE ? undefined : title
		} else if (codelistValue(href) === SETTLEMENT_LEVEL) {
			titles.settlement = title
		} else if (componentJoinKey(href)?.startsWith(MUNICIPALITY_ID_PREFIX)) {
			titles.locality = title
		}
	}

	return titles
}

export function createESNavarraAdapter(): CorpusAdapter {
	return {
		id: ES_NAVARRA_ADAPTER_ID,
		defaultLicense: ES_NAVARRA_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.NavarraInspireAddresses,
		surface: SurfaceOrigin.Rendered,
		description:
			"INSPIRE Addresses (Gobierno de Navarra): house-number-level addresses for Navarra, as 272 zipped GML partitions.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !ES_NAVARRA_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(ES_NAVARRA_ADAPTER_ID, ES_NAVARRA_COUNTRIES, opts.country)
			}

			let emitted = 0

			for (const archivePath of await archivePaths(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				// The markup stream is read directly rather than through `#inspire/stream`,
				// because this publisher writes no component feature for an address to reference.
				// The index would stay empty and no address would ever be deferred.
				for await (const address of streamMarkupElements(inspireGMLChunks(archivePath, GML_MEMBER), ADDRESS_ELEMENT, {
					xml: true,
				})) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const row = composeRow(address)

					if (!row) continue

					yield row

					emitted++
				}
			}
		},
	}
}

/**
 * One address's row, or undefined when it holds too little to render.
 */
function composeRow(address: MarkupElement): CanonicalRow | undefined {
	const addressID = address.attributes["gml:id"]?.trim()

	if (voidDesignatorTypes(address).has(HOUSE_NUMBER_TYPE)) {
		throw new VoidDesignatorError(ES_NAVARRA_ADAPTER_ID, addressID, HOUSE_NUMBER_TYPE)
	}

	const { street, postcode, locality, settlement } = navarraReferencedTitles(address)

	// Navarra's settlement is a fifth-order title, a *concejo* within the municipality.
	// `cadastralRow` writes it as a dependent locality only where it differs from the municipality.
	return cadastralRow(
		{
			street,
			house: spanishHouseNumber(designatorsByType(address), HOUSE_NUMBER_TYPE),
			postcode,
			locality,
			settlement,
			addressID,
		},
		{ adapterID: ES_NAVARRA_ADAPTER_ID, license: ES_NAVARRA_LICENSE }
	)
}

/**
 * Every archive under `inputPath`, which is one `.zip`, one unpacked `.gml`, or a directory holding either.
 *
 * A directory is the ordinary case, because the publisher ships 272 partitions
 * and a caller harvesting the province points at the directory it fetched them into.
 * A directory holding neither raises rather than yielding zero rows, so a wrong path
 * reports itself instead of reading as an empty publisher.
 */
async function archivePaths(inputPath: PathBuilderLike): Promise<readonly PathBuilderLike[]> {
	const path = PathBuilder.from(inputPath)
	const basename = path.basename().toLowerCase()

	if (basename.endsWith(".zip") || basename.endsWith(".gml")) return [path]

	const names = await Globerator.from("*.{zip,gml}", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${ES_NAVARRA_ADAPTER_ID} adapter: ${path.toString()} holds no .zip archive or .gml member`)
	}

	return names.map((name) => path(name))
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const esNavarraAdapter = createESNavarraAdapter()
