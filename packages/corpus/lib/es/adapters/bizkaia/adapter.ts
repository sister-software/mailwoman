/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `es-bizkaia`: the INSPIRE Addresses theme the Diputación Foral de Bizkaia publishes, read from its
 * per-municipality archives together with the component features its WFS serves.
 *
 * The ATOM service at `https://apli.bizkaia.eus/apps/Danok/INSPIRE/addresses.xml` lists 112
 * municipality entries, one zipped GML each. Catastro's national feed links this service rather than
 * serving its data. The publisher is therefore a register of its own.
 *
 * The archives hold only addresses. That shapes this reader. Abadiño's
 * `ES.BFA.AD.001.zip` holds one member, `ES.BFA.AD.gml`, whose 1,360 `ad:Address` features write
 * 4,080 `ad:component` references and not one `ad:ThoroughfareName`, `ad:PostalDescriptor` or
 * `ad:AdminUnitName` feature. Every reference is a stored-query URL on
 * `https://geo.bizkaia.eus/arcgisserverinspire/…` addressing an `adComponent.<n>` the ATOM feed never
 * publishes. A reader given only those archives therefore writes every address in the province without
 * its street, its postcode or its municipality.
 *
 * Those features are on the publisher's WFS. It serves the whole province in one request per type. The
 * service answers `ad:ThoroughfareName` with `numberMatched="6921"`, `ad:PostalDescriptor` with
 * `96` and `ad:AdminUnitName` with `113`, and a `GetFeature` with `COUNT=10000` returns each type
 * whole: 6,921 thoroughfare names arrive in one 13,916,056-byte document. One request per type is
 * also the only way to read them. The capabilities document does not advertise
 * `ImplementsResultPaging` and its `CountDefault` is 1,000, so a reader that paged a type would
 * receive the first page again. Acquisition saves those three documents and the adapter reads a
 * directory holding them beside the municipality archives.
 *
 * The join is therefore across files, and the index is complete before the first address is read:
 * the first pass reads every input for component features and the second reads every input for
 * addresses. An unresolved reference is a value the reader asked for and could not read, and it
 * raises.
 *
 * Two of the publisher's own spellings decide what a row records.
 *
 * A thoroughfare name is a cadastral field rather than a street name:
 * `BO\TRAÑA-MATIENA(1)` is the street-type abbreviation `BO`, a backslash, the name, and the
 * street's own sequence code in parentheses. All 6,921 take that form. The row keeps the
 * abbreviation, as the Dirección General del Catastro's own rendered line does with `CL SANTIAGO
 * APOSTOL`, writes a space where the cadastre writes its separator, and drops the sequence code
 * because it is an identifier rather than part of the name.
 *
 * The house number is the last of the four dot-separated fields of the designator, and the
 * designator is a cadastral code: `48.001.00026.003` is municipality 48001, street 00026 and number
 * 003. All 1,360 of Abadiño's designators have exactly four fields, its street field is five digits
 * wide on 1,360 of 1,360, and its number field is fixed-width three. The row writes that field with
 * its padding removed and every other character as written. Four shapes appear, counted over Abadiño:
 *
 * | shape | count | written |
 * | --- | --- | --- |
 * | `003` | 688 | `3` |
 * | `008A` | 470 | `8A` |
 * | `001BIS`, `004IZ`, `004DR` | 21 | `1BIS`, `4IZ`, `4DR` |
 * | `033005`, `019A02` | 181 | `33005`, `19A02` |
 *
 * The first three are an ordinary Spanish number, a number with a letter, and a number with a
 * *bis*, *izquierda* or *derecha* qualifier. The fourth is two fields concatenated and what its
 * second field designates is not established: it is three digits wide like the number itself, and
 * no document the publisher publishes states what it counts. The row therefore writes the
 * publisher's own concatenation with its padding removed. A split on a guessed separator would
 * state a number the cadastre does not hold.
 *
 * The municipality is `ad:AdminUnitName` at `3rdOrder`, which is the only level the service
 * publishes: 113 of 113 of its administrative-unit features state it, and their names are padded
 * with trailing spaces that `#inspire/address` trims. A reader keyed on the `4thOrder` that Czechia,
 * Slovakia and Gipuzkoa use finds no municipality here.
 *
 * The publisher's own cross-rendering is `ad:LocatorName`, populated on 1,360 of 1,360 addresses:
 * `48 001 CL\TRAÑAETXOSTE(00066) 002` for the address whose designator is `48.001.00066.002`. It
 * restates the municipality code, the street type and name, the street code zero-padded to five, and
 * the number field, and it is written inside the archive while the street itself comes from a
 * separate WFS document. The adapter's test compares the resolved street and the composed number
 * against it to check that the right feature was joined. The register's
 * personal-data review reads these values as internal cadastral references rather than names, and
 * the adapter writes none of them into a row.
 *
 * No service either publisher runs was found to render a postal address for this province: the
 * ArcGIS layer behind the WFS exposes only INSPIRE fields. The number's unexplained second field
 * therefore stays open.
 */

import { openReadStream } from "@mailwoman/core/fs/streams"
import { type MarkupElement, streamMarkupElements } from "@mailwoman/core/html/elements"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { cadastralRow } from "#es/cadastre"
import {
	adminUnitLevel,
	componentHrefs,
	componentJoinKey,
	designator,
	designatorsByType,
	inspireNameIs,
	placeName,
	postalDescriptorCode,
	thoroughfareName,
	voidDesignatorTypes,
} from "#inspire/address"
import { inspireGMLChunks } from "#inspire/archive"
import { InspireArchiveError, UnresolvedComponentReferenceError, VoidDesignatorError } from "#inspire/errors"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const ES_BIZKAIA_ADAPTER_ID = "es-bizkaia"

/**
 * The jurisdiction this adapter emits.
 */
export const ES_BIZKAIA_COUNTRIES: readonly string[] = ["ES"]

/**
 * The license the address-source register elected for this publisher.
 *
 * Bizkaia states no license instrument, so no SPDX identifier is written and this records the
 * publisher's own words. Its INSPIRE metadata states the controlled values `No limitations to
 * public access` and `No conditions to access and use`, and its feed-level `rights` adds the
 * condition that authorship and ownership of the BFA be stated as «©Bizkaiko Foru Aldundia». The
 * register records two contradictions it did not resolve: all 112 municipality entries also read
 * `Copyright (c) 2017", ES.BFA; all rights reserved`, and Catastro's national feed labels this
 * publisher `CC BY 3.0 ES`. No document Bizkaia publishes states that label.
 */
export const ES_BIZKAIA_LICENSE = "No conditions to access and use, with attribution to «©Bizkaiko Foru Aldundia»"

/**
 * The member of a municipality's archive that holds the GML.
 *
 * Each archive ships one member, `ES.BFA.AD.gml` whichever municipality it holds,
 * so the extension selects it and the archive's own name identifies the municipality.
 */
const GML_MEMBER = /\.gml$/iu

/**
 * The feature types in the saved WFS documents, indexed before any address is read.
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
 * The only level the service publishes, on 113 of 113 `ad:AdminUnitName` features.
 */
const MUNICIPALITY_LEVEL = "3rdOrder"

/**
 * The designator type the publisher writes.
 *
 * The href the publisher writes repeats the value,
 * `…/LocatorDesignatorTypeValue/buildingIdentifier/buildingIdentifier`, and `codelistValue`
 * reads the final segment, so the type name is the same as everyone else's.
 */
const HOUSE_NUMBER_TYPE = "buildingIdentifier"

/**
 * How many dot-separated fields a designator has.
 *
 * Municipality, street, number: `48.001.00026.003` splits the municipality code across two.
 */
const DESIGNATOR_FIELDS = 4

/**
 * The street name and type a thoroughfare feature states, without its cadastral decoration.
 *
 * `BO\TRAÑA-MATIENA(1)` answers `BO TRAÑA-MATIENA`.
 * The backslash is the cadastre's separator between the street-type abbreviation
 * and the name, and the trailing parenthesis holds the street's sequence code.
 *
 * The address's own designator repeats that code as its third field.
 *
 * @returns The street, or null where the feature states no name.
 */
export function bizkaiaStreet(feature: MarkupElement): string | null {
	const text = thoroughfareName(feature)

	if (!text) return null

	const street = text
		.replace(/\((\d+)\)\s*$/u, "")
		.replaceAll("\\", " ")
		.replaceAll(/\s+/gu, " ")
		.trim()

	return street || null
}

/**
 * The street's sequence code a thoroughfare feature states, as the feature writes it.
 *
 * The code the address's designator joins on.
 * The publisher's own `ad:LocatorName` therefore checks the join rather than copying it.
 *
 * @returns The digits inside the trailing parentheses, or null where there are none.
 */
export function bizkaiaStreetCode(feature: MarkupElement): string | null {
	return /\((\d+)\)\s*$/u.exec(thoroughfareName(feature) ?? "")?.[1] ?? null
}

/**
 * The house number the designator's fourth field states.
 *
 * The field is fixed-width three.
 * The row writes it with that padding removed and every other character as written.
 *
 * This module's header tabulates the four shapes it takes, with their counts.
 *
 * @returns The number, or null where the designator is absent or does not have four fields.
 */
export function bizkaiaHouseNumber(byType: ReadonlyMap<string, readonly string[]>): string | null {
	const code = designator(byType, HOUSE_NUMBER_TYPE)

	if (!code) return null

	const fields = code.split(".")

	if (fields.length !== DESIGNATOR_FIELDS) return null

	const number = fields[DESIGNATOR_FIELDS - 1]!.replace(/^0+(?=.)/u, "")

	return number || null
}

export function createESBizkaiaAdapter(): CorpusAdapter {
	return {
		id: ES_BIZKAIA_ADAPTER_ID,
		defaultLicense: ES_BIZKAIA_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.BizkaiaInspireAddresses,
		surface: SurfaceOrigin.Rendered,
		description:
			"INSPIRE Addresses (Diputación Foral de Bizkaia): house-number-level addresses for the province, from 112 municipality archives joined against saved WFS component pages.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !ES_BIZKAIA_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(ES_BIZKAIA_ADAPTER_ID, ES_BIZKAIA_COUNTRIES, opts.country)
			}

			const inputs = await inputPaths(opts.inputPath)
			const referenced = new Map<string, MarkupElement>()

			for (const path of inputs) {
				if (opts.signal?.aborted) return

				for await (const feature of streamMarkupElements(memberChunks(path), COMPONENT_ELEMENTS, { xml: true })) {
					const id = feature.attributes["gml:id"]

					if (id) {
						referenced.set(id, feature)
					}
				}
			}

			// Every address references a street, a postcode and a municipality, so an empty
			// index turns each row into a row with no place rather than into fewer rows.
			if (!referenced.size) {
				throw new InspireArchiveError(
					ES_BIZKAIA_ADAPTER_ID,
					`${PathBuilder.from(opts.inputPath).toString()} holds no component feature. The municipality archives carry addresses alone, and the features they reference come from the publisher's WFS.`
				)
			}

			let emitted = 0

			for (const path of inputs) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				for await (const address of streamMarkupElements(memberChunks(path), "ad:Address", { xml: true })) {
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
 * One address's row, or null when it has too little to render.
 */
function composeRow(address: MarkupElement, referenced: ReadonlyMap<string, MarkupElement>): CanonicalRow | null {
	const addressID = address.attributes["gml:id"]?.trim() ?? null

	if (voidDesignatorTypes(address).has(HOUSE_NUMBER_TYPE)) {
		throw new VoidDesignatorError(ES_BIZKAIA_ADAPTER_ID, addressID, HOUSE_NUMBER_TYPE)
	}

	let street: string | null = null
	let postcode: string | null = null
	let locality: string | null = null
	let settlement: string | null = null

	for (const href of componentHrefs(address)) {
		const key = componentJoinKey(href)
		const feature = key ? referenced.get(key) : undefined

		if (!feature) throw new UnresolvedComponentReferenceError(ES_BIZKAIA_ADAPTER_ID, addressID, href)

		const name = feature.name

		if (inspireNameIs(name, "ad:ThoroughfareName")) {
			street = bizkaiaStreet(feature)
		} else if (inspireNameIs(name, "ad:PostalDescriptor")) {
			postcode = postalDescriptorCode(feature)
		} else if (inspireNameIs(name, "ad:AddressAreaName")) {
			settlement = placeName(feature)
		} else if (inspireNameIs(name, "ad:AdminUnitName") && adminUnitLevel(feature) === MUNICIPALITY_LEVEL) {
			locality = placeName(feature)
		}
	}

	// Bizkaia's number is read by its own reader rather than `spanishHouseNumber`, because its
	// designator packs a fixed-width number field that the other three cadastres do not write.
	return cadastralRow(
		{
			street,
			house: bizkaiaHouseNumber(designatorsByType(address)),
			postcode,
			locality,
			settlement,
			addressID,
		},
		{ adapterID: ES_BIZKAIA_ADAPTER_ID, license: ES_BIZKAIA_LICENSE }
	)
}

/**
 * One input's bytes, whether it arrives zipped or unpacked.
 */
function memberChunks(path: PathBuilderLike): AsyncIterable<string | Uint8Array> {
	const resolved = PathBuilder.from(path)

	if (resolved.basename().toLowerCase().endsWith(".zip")) return inspireGMLChunks(resolved, GML_MEMBER)

	return openReadStream(resolved)
}

/**
 * Every input under `inputPath`, which is one file or a directory holding several.
 *
 * The two passes read the same list, so an input holding addresses and an input holding
 * component features need not be told apart: a municipality archive contributes addresses
 * to the second pass and no feature to the first, and a saved WFS page the reverse.
 * Extension cannot decide: a hand-assembled input can hold both, and the
 * publisher's own naming distinguishes neither.
 *
 * A path holding no input raises rather than yielding zero rows, so a wrong path
 * reports itself instead of reading as an empty publisher.
 */
async function inputPaths(inputPath: PathBuilderLike): Promise<readonly PathBuilderLike[]> {
	const path = PathBuilder.from(inputPath)
	const basename = path.basename().toLowerCase()

	if (basename.endsWith(".zip") || basename.endsWith(".gml") || basename.endsWith(".xml")) return [path]

	const names = await Globerator.from("*.{zip,gml,xml}", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new InspireArchiveError(ES_BIZKAIA_ADAPTER_ID, `${path.toString()} holds no .zip archive or saved WFS page`)
	}

	return names.map((name) => path(name))
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const esBizkaiaAdapter = createESBizkaiaAdapter()
