/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `es-catastro`: the INSPIRE Addresses theme the Dirección General del Catastro publishes, read
 * from its per-municipality zipped GML.
 *
 * The ATOM service at `https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/ES.SDGC.AD.atom.xml`
 * lists 55 entries, and 52 of them are the Dirección General del Catastro's own provinces. The other
 * three link the foral cadastres of Bizkaia, Gipuzkoa and Navarra, which state their own terms and
 * have an adapter each. Every DGC entry links a province feed listing one zipped GML per
 * municipality, so a caller harvests municipality by municipality and this adapter reads one archive
 * or a directory of them.
 *
 * Three properties of the file decide the reader, and each of the three would silently empty a row
 * if it were read the way the other INSPIRE publishers are read.
 *
 * The archive carries two members. `A.ES.SDGC.AD.<code>.gml` is the data and
 * `A.ES.SDGC.AD.MD.<code>.xml` is its ISO 19139 metadata record. A member selector matching `.xml`
 * therefore selects the metadata record. That record carries no `AD:Address` at all, so
 * {@linkcode GML_MEMBER} matches the extension that holds the features.
 *
 * The GML declares `<?xml version="1.0" encoding="ISO-8859-1"?>` and is not valid UTF-8: Ceuta's
 * 11,861,975-byte member carries 26 bytes above 0x7F, one of which is the `Ñ` of a street name.
 * `streamMarkupElements` decodes with a UTF-8 `TextDecoder`, which answers those bytes with U+FFFD,
 * so the bytes pass through `decodeByteStream` first. {@linkcode assertLatin1Declaration} reads the
 * declaration rather than trusting this note, because a publisher that re-encodes its output would
 * otherwise have every accented name mojibaked under a reader that still claimed to be right.
 *
 * The file binds the INSPIRE namespaces to upper-case prefixes, `AD:Address` and `GN:text`, and
 * states a designator type and an administrative level as element text rather than as a codelist
 * URI. `#inspire/address` matches an element by its local name and accepts either form of a coded
 * value, so the readers there serve this publisher. Only the element names this module passes to the
 * markup stream carry the upper-case prefix.
 *
 * Each address references exactly three features by local `#` fragment, measured as 8,126 of 8,126
 * addresses in Ceuta carrying one `ES.SDGC.PD`, one `ES.SDGC.TN` and one `ES.SDGC.AU` reference.
 * Those features are written after the addresses — Ceuta's 511 of them sit in the last 530,000 bytes
 * of the member — so the adapter reads the member twice through
 * {@linkcode streamIndexedInspireRows} rather than holding every address until the document ends.
 *
 * The number is one designator, typed `1`. The publisher's own rendering fixes what that type means
 * and what the value `S-N` means. `Consulta_DNPRC` on the OVC web service answers a cadastral
 * reference with the address the Cadastre holds for it, as `<ldt>`, plus the fields it is built
 * from: `tv` the street-type abbreviation, `nv` the street name, `pnp` the number, `plp` its letter,
 * `dp` the postcode and `nm` the municipality. The cadastral reference is the tail of the address's
 * own `gml:id`, so every row this adapter writes can be put beside the publisher's own line:
 *
 * | `gml:id` tail | designator | `<ldt>` |
 * | --- | --- | --- |
 * | `9744803TE8794S` | `13` | `CL SANTIAGO APOSTOL 13 51002 CEUTA (CEUTA)` |
 * | `9745701TE8794S` | `13D` | `CL SANTIAGO APOSTOL 13(D) 51002 CEUTA (CEUTA)` |
 *
 * So the designator is `pnp` with `plp` appended, and the street is `tv` followed by `nv`, which is
 * the `AD:ThoroughfareName` text verbatim once its leading space is trimmed. The abbreviation stays
 * in the street component because the publisher writes it in its own rendered line. Expanding `CL`
 * to `Calle` would state something the Cadastre did not.
 *
 * `S-N` is *sin número*, the publisher stating that the address has no number, and it is 856 of
 * Ceuta's 8,126 designators. A row carrying it writes no `house_number`, because the string is a
 * statement about the number rather than a number.
 *
 * One reference form states an absence the same way. The postal-descriptor reference's final segment
 * is the postcode, and 70 of Ceuta's 8,126 addresses write `#ES.SDGC.PD.55.101.` with that segment
 * empty, against five `AD:PostalDescriptor` features the file does publish. Those 70 are the only
 * unresolvable references in the member: the thoroughfare and administrative-unit references resolve
 * 8,126 of 8,126 each. A reference whose final segment is empty is therefore read as the publisher
 * holding no value for that component, and every other unresolved reference raises.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { decodeByteStream } from "@mailwoman/core/fs/streams"
import type { MarkupElement } from "@mailwoman/core/html/elements"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { referenceStatesNoValue, spanishHouseNumber } from "#es/cadastre"
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
export const ES_CATASTRO_ADAPTER_ID = "es-catastro"

/**
 * The jurisdiction this adapter emits.
 *
 * The 52 province feeds cover peninsular Spain, the Balearics, the Canaries, Ceuta and Melilla.
 * The three Basque provinces and Navarra keep their own cadastres and their own adapters.
 */
export const ES_CATASTRO_COUNTRIES: readonly string[] = ["ES"]

/**
 * The licence the address-source register elected for this publisher.
 *
 * The register elects the titled instrument, `Licencia de acceso y uso de los servicios y conjuntos
 * de datos INSPIRE de la Dirección General del Catastro` at version 1.0, rather than the older
 * `all rights reserved` template the feed still carries. It names no licence instrument a
 * Creative Commons label or an SPDX identifier would cover, so the row records the instrument's
 * own title.
 *
 * That decision reads `refused` for `redistribute-data`: clause 1 withholds distribution
 * of the information as supplied, and requires transformation before any public use.
 * Ingest, transformation and training are permitted, which is what this adapter performs.
 */
export const ES_CATASTRO_LICENSE =
	"Licencia de acceso y uso de los servicios y conjuntos de datos INSPIRE de la Dirección General del Catastro"

/**
 * The member of a municipality's archive that holds the GML.
 *
 * The archive ships two members and the other is `A.ES.SDGC.AD.MD.<code>.xml`,
 * the ISO 19139 metadata record.
 * A selector matching `.xml` reads that record, which carries no `AD:Address`.
 */
const GML_MEMBER = /\.gml$/iu

/**
 * The encoding the publisher declares and writes.
 */
const DECLARED_ENCODING = "iso-8859-1"

/**
 * The feature types an address references, indexed in the first pass over the member.
 *
 * `AD:AddressAreaName` is listed although Ceuta publishes none, because the schema admits one and a
 * municipality that writes one would otherwise have its settlement part read as an unresolved reference.
 */
const COMPONENT_ELEMENTS = [
	"AD:ThoroughfareName",
	"AD:PostalDescriptor",
	"AD:AdminUnitName",
	"AD:AddressAreaName",
] as const

/**
 * The element each address is written as.
 */
const ADDRESS_ELEMENT = "AD:Address"

/**
 * The administrative level that is the municipality.
 *
 * The publisher writes `<AD:level>4</AD:level>` as text where the other INSPIRE publishers
 * write the `AdministrativeHierarchyLevel/4thOrder` codelist URI, so both spellings
 * are accepted and a reference to a coarser unit is left out of the row.
 */
const MUNICIPALITY_LEVELS = new Set(["4", "4thOrder"])

/**
 * The designator type the publisher writes on every address.
 *
 * Measured over Ceuta: 8,126 of 8,126 addresses carry exactly one designator
 * and its `AD:type` is the text `1`.
 * The value is the house number, which `Consulta_DNPRC`'s `pnp` and `plp` fields
 * confirm for the two addresses tabulated in this module's header.
 */
const HOUSE_NUMBER_TYPE = "1"

/**
 * Raises unless the member declares the encoding this reader decodes it from.
 *
 * The declaration is the publisher's statement about its own bytes, and a reader that assumed ISO-8859-1
 * through a change to UTF-8 would mojibake every accented street name while reporting success.
 * A member that states no encoding is accepted, because XML's default is UTF-8
 * and ISO-8859-1 decoding of ASCII bytes is the same text.
 */
async function* assertLatin1Declaration(
	chunks: AsyncIterable<Uint8Array>,
	archivePath: PathBuilderLike
): AsyncIterable<Uint8Array> {
	let first = true

	for await (const chunk of chunks) {
		if (first) {
			first = false

			const declaration = /<\?xml[^>]*encoding="([^"]+)"/iu.exec(Buffer.from(chunk.subarray(0, 512)).toString("latin1"))
			const declared = declaration?.[1]?.toLowerCase()

			if (declared && declared !== DECLARED_ENCODING) {
				throw new TypeError(
					`${ES_CATASTRO_ADAPTER_ID} adapter: ${archivePath.toString()} declares encoding ` +
						`${stringifyJSON(declaration?.[1])}, and this reader decodes ${stringifyJSON(DECLARED_ENCODING)}`
				)
			}
		}

		yield chunk
	}
}

/**
 * One archive member's bytes, re-encoded into the UTF-8 the markup reader decodes.
 */
function memberChunks(archivePath: PathBuilderLike): AsyncIterable<Uint8Array> {
	return decodeByteStream(
		assertLatin1Declaration(inspireGMLChunks(archivePath, GML_MEMBER), archivePath),
		DECLARED_ENCODING
	)
}

export function createESCatastroAdapter(): CorpusAdapter {
	return {
		id: ES_CATASTRO_ADAPTER_ID,
		defaultLicense: ES_CATASTRO_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.CatastroInspireAddresses,
		surface: SurfaceOrigin.Rendered,
		description:
			"INSPIRE Addresses (Dirección General del Catastro): house-number-level addresses for Spain outside the foral cadastres, one zipped GML per municipality.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !ES_CATASTRO_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(ES_CATASTRO_ADAPTER_ID, ES_CATASTRO_COUNTRIES, opts.country)
			}

			let emitted = 0

			// One archive per municipality, each a document whose references resolve inside it.
			for (const archivePath of await archivePaths(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				for await (const row of streamIndexedInspireRows<MarkupElement>({
					chunks: () => memberChunks(archivePath),
					addressElement: ADDRESS_ELEMENT,
					componentElements: COMPONENT_ELEMENTS,
					// The subtree is kept, because one feature answers a street, a postcode
					// or a place name depending on which type it is.
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
 * One address's row, or undefined when it carries too little to render.
 *
 * The reference index is complete before this is called, so a reference resolving to no
 * feature is a value the reader asked for and could not read, and it raises.
 */
function composeRow(address: MarkupElement, referenced: ReadonlyMap<string, MarkupElement>): CanonicalRow | undefined {
	const addressID = address.attributes["gml:id"]?.trim()

	if (voidDesignatorTypes(address).has(HOUSE_NUMBER_TYPE)) {
		throw new VoidDesignatorError(ES_CATASTRO_ADAPTER_ID, addressID, HOUSE_NUMBER_TYPE)
	}

	let street: string | undefined
	let postcode: string | undefined
	let locality: string | undefined
	let settlement: string | undefined

	for (const href of componentHrefs(address)) {
		const key = componentJoinKey(href)

		if (key && referenceStatesNoValue(key)) continue

		const feature = key ? referenced.get(key) : undefined

		if (!feature) throw new UnresolvedComponentReferenceError(ES_CATASTRO_ADAPTER_ID, addressID, href)

		const name = feature.name

		if (inspireNameIs(name, "ad:ThoroughfareName")) {
			street = thoroughfareName(feature)
		} else if (inspireNameIs(name, "ad:PostalDescriptor")) {
			postcode = postalDescriptorCode(feature)
		} else if (inspireNameIs(name, "ad:AddressAreaName")) {
			settlement = placeName(feature)
		} else if (inspireNameIs(name, "ad:AdminUnitName") && MUNICIPALITY_LEVELS.has(adminUnitLevel(feature) ?? "")) {
			locality = placeName(feature)
		}
	}

	const place = locality ?? settlement

	if (!place) return undefined

	const components: CanonicalRow["components"] = {}
	const house = spanishHouseNumber(designatorsByType(address), HOUSE_NUMBER_TYPE)

	if (house) {
		components.house_number = house
	}

	if (street) {
		components.street = street
	}

	if (postcode) {
		components.postcode = postcode
	}

	components.locality = place

	if (settlement && locality && settlement !== locality) {
		components.dependent_locality = settlement
	}

	const rendered = formatAddressRow(components, "ES", { singleLine: true })

	if (!rendered) return undefined

	const { raw, components: aligned } = rendered

	return {
		raw,
		components: aligned,
		country: "ES",
		locale: "es-ES",
		source: ES_CATASTRO_ADAPTER_ID,
		source_id: addressID ? `${ES_CATASTRO_ADAPTER_ID}-${addressID}` : stableSourceID(ES_CATASTRO_ADAPTER_ID, aligned),
		corpus_version: "",
		license: ES_CATASTRO_LICENSE,
	}
}

/**
 * Every archive under `inputPath`, which is one `.zip` or a directory holding them.
 *
 * A directory holding no archive raises rather than yielding zero rows, so a wrong
 * path reports itself instead of reading as an empty publisher.
 */
async function archivePaths(inputPath: PathBuilderLike): Promise<readonly PathBuilderLike[]> {
	const path = PathBuilder.from(inputPath)

	if (path.basename().toLowerCase().endsWith(".zip")) return [path]

	if (path.basename().toLowerCase().endsWith(".gml")) return [path]

	const names = await Globerator.from("*.{zip,gml}", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${ES_CATASTRO_ADAPTER_ID} adapter: ${path.toString()} holds no .zip archive`)
	}

	return names.map((name) => path(name))
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const esCatastroAdapter = createESCatastroAdapter()
