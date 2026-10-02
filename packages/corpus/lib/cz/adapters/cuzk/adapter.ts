/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `cz-cuzk`: the INSPIRE Addresses theme ČÚZK publishes, read from its per-municipality GML.
 *
 * ČÚZK, the Czech Office for Surveying, Mapping and Cadastre, publishes one zipped GML per
 * municipality through the ATOM service at `https://atom.cuzk.gov.cz/AD/AD.xml`, which lists 6,258
 * dataset feeds. Each feed offers the same data in EPSG:5514 and EPSG:4258. The adapter reads a
 * single archive or a directory of them, so a caller harvests municipality by municipality rather
 * than waiting on a national file.
 *
 * Every address and every feature it references sit in the same archive, which is what makes this
 * publisher cheap to read. The `ad:component` hrefs look external, because ČÚZK writes an absolute
 * WFS stored-query URL on `services.cuzk.cz`, and the `Id=` parameter of each one matches a
 * `gml:id` in the file at hand. Measured over `584282.xml`: 5,460 component references across 1,365
 * addresses, 0 of them reaching outside the archive. Only `ad:parcel` and `ad:building` point at
 * genuinely separate themes, and the adapter reads neither.
 *
 * ČÚZK states one condition of use and states it uniformly. Every one of the 6,259 `rights` elements
 * in the ATOM service document reads `žádné podmínky neplatí`, which renders INSPIRE's controlled
 * value `no conditions apply to access and use`. The address-source register elects that and names
 * no licence instrument, so no SPDX identifier exists to record and the rows carry the controlled
 * value itself. The register also carries a caution this adapter cannot resolve: that value states
 * the absence of a restriction on access and use rather than granting copyright, so what it permits
 * beyond access and use rests on Czech law.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import type { MarkupElement } from "@mailwoman/core/html/elements"
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
} from "#inspire/address"
import { inspireGMLChunks } from "#inspire/archive"
import { streamInspireRows } from "#inspire/stream"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const CZ_CUZK_ADAPTER_ID = "cz-cuzk"

/**
 * The jurisdiction this adapter emits.
 */
export const CZ_CUZK_COUNTRIES: readonly string[] = ["CZ"]

/**
 * The licence recorded on every row.
 *
 * INSPIRE's controlled value, in the English the register renders it to, because ČÚZK
 * names no licence instrument and the register therefore writes no SPDX identifier.
 */
export const CZ_CUZK_LICENSE = "no conditions apply to access and use"

/**
 * The feature types an address references, which the adapter indexes as they arrive.
 *
 * `ad:Address` carries its number inline and is read by the driver rather than listed here.
 * These four hold the street, the postcode and the two place names, and they are read in the same pass
 * because an archive writes them interleaved with the addresses rather than ahead of them.
 */
const COMPONENT_TYPES = [
	"ad:ThoroughfareName",
	"ad:PostalDescriptor",
	"ad:AdminUnitName",
	"ad:AddressAreaName",
] as const

/**
 * The member of a municipality's archive that holds the GML.
 *
 * ČÚZK names it for the municipality, as `584282.xml`, and ships one member per archive,
 * so the extension selects it without the adapter knowing the code.
 *
 * ČÚZK's central directory records the member's size as the ZIP64 sentinel `0xFFFFFFFF`
 * on at least one archive, so a reader trusting that slot reads the wrong length.
 * `readZipEntry`, which {@linkcode inspireGMLChunks} uses, reads the ZIP64 extra field
 * where the real length lives.
 */
const GML_MEMBER = /\.xml$/iu

/**
 * The series prefix a street name makes unnecessary.
 *
 * Czechia numbers a building in one of two series.
 * A `číslo popisné` is the descriptive number an ordinary building carries, and a
 * `číslo evidenční` numbers a recreational or temporary building in a separate series,
 * so the same digits can name two buildings in one municipality.
 */
const DESCRIPTIVE_NUMBER_PREFIX = "č.p."

/**
 * The house number as ČÚZK writes it, including the series prefix wherever ČÚZK writes one.
 *
 * ČÚZK states the series as a `buildingIdentifierPrefix` designator on every address
 * and renders it in three of four cases.
 * Its own `ad:alternativeIdentifier` is the authority, and comparing this function's
 * whole rendered line against that string over the 1,669 addresses of Židlochovice
 * and Unkovice is what the table below was read from:
 *
 * | | street present | street absent |
 * | --- | --- | --- |
 * | `č.p.` | `Dezortova 803` | `č.p. 217, 66463 Unkovice` |
 * | `č.ev.` | `Komenského č.ev. 502` | `č.ev. 38, 66463 Unkovice` |
 *
 * So the descriptive prefix is dropped only when a street name already places the number.
 * A number standing alone keeps its prefix, because the two series overlap
 * and the digits alone would not say which building is meant.
 *
 * An earlier rule that dropped `č.p.` everywhere disagreed with the publisher on 254 of those 1,669 rows.
 *
 * A prefix other than `č.p.` is kept in every case, including one these two municipalities did
 * not carry, because the observed values come from 2 of 6,258 municipalities and keeping an
 * unrecognized prefix preserves a distinction the publisher drew rather than discarding it.
 */
function czechHouseNumber(
	byType: ReadonlyMap<string, readonly string[]>,
	options: { street?: string }
): string | undefined {
	const number = designator(byType, "buildingIdentifier")

	if (!number) return undefined

	const prefix = designator(byType, "buildingIdentifierPrefix")

	if (!prefix) return number

	if (options.street && prefix === DESCRIPTIVE_NUMBER_PREFIX) return number

	return `${prefix} ${number}`
}

export function createCzCuzkAdapter(): CorpusAdapter {
	return {
		id: CZ_CUZK_ADAPTER_ID,
		defaultLicense: CZ_CUZK_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.CuzkInspireAddresses,
		surface: SurfaceOrigin.Rendered,
		description: "INSPIRE Addresses (ČÚZK): house-number-level addresses for Czechia, one zipped GML per municipality.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !CZ_CUZK_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(CZ_CUZK_ADAPTER_ID, CZ_CUZK_COUNTRIES, opts.country)
			}

			let emitted = 0

			// One archive per municipality, each a document whose references resolve inside it,
			// so the index is per archive rather than shared across the 6,258.
			for (const archivePath of await archivePaths(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				for await (const row of streamInspireRows<MarkupElement>({
					chunks: inspireGMLChunks(archivePath, GML_MEMBER),
					componentElements: COMPONENT_TYPES,
					// The subtree is kept, because one feature answers a street, a postcode
					// or a place name depending on which type it is.
					index: (feature) => feature,
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
 * One address's row, `undefined` when it carries too little to render, or `"deferred"`
 * when a reference it names is not indexed yet.
 *
 * Deferring rather than dropping matters because an unresolved reference and an absent
 * one are different conditions, and only the archive's own ordering tells them apart.
 * With `final` set the whole member has been read, so an unresolved reference is an
 * absence the publisher is responsible for and the row is rendered without it.
 */
function composeRow(
	address: MarkupElement,
	referenced: ReadonlyMap<string, MarkupElement>,
	options: { final?: boolean } = {}
): CanonicalRow | undefined | "deferred" {
	const byType = designatorsByType(address)

	let street: string | undefined
	let postcode: string | undefined
	let locality: string | undefined
	let settlement: string | undefined
	let unresolved = false

	for (const href of componentHrefs(address)) {
		const key = componentJoinKey(href)

		if (!key) continue

		const feature = referenced.get(key)

		if (!feature) {
			// Only the four themes this adapter reads are expected in the archive.
			// A parcel or building reference carries no `Id` the loop above accepted.
			if (/^(?:TF|PD|AU|AA)\./u.test(key)) {
				unresolved = true
			}

			continue
		}

		if (feature.name === "ad:ThoroughfareName") {
			street = thoroughfareName(feature)
		} else if (feature.name === "ad:PostalDescriptor") {
			postcode = postalDescriptorCode(feature)
		} else if (feature.name === "ad:AddressAreaName") {
			settlement = placeName(feature)
		} else if (feature.name === "ad:AdminUnitName" && adminUnitLevel(feature) === "4thOrder") {
			locality = placeName(feature)
		}
	}

	if (unresolved && !options.final) return "deferred"

	// The street decides whether the number keeps its series prefix, so it is read first.
	const house = czechHouseNumber(byType, { street })
	const place = locality ?? settlement

	if (!place) return undefined

	if (!postcode && !street) return undefined

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

	components.locality = place

	// A `část obce`, the settlement part, is a dependent locality when the municipality is known.
	if (settlement && locality && settlement !== locality) {
		components.dependent_locality = settlement
	}

	const rendered = formatAddressRow(components, "CZ", { singleLine: true })

	if (!rendered) return undefined

	const { raw, components: aligned } = rendered
	const seed = address.attributes["gml:id"]?.trim()

	return {
		raw,
		components: aligned,
		country: "CZ",
		locale: "cs-CZ",
		source: CZ_CUZK_ADAPTER_ID,
		source_id: seed ? `${CZ_CUZK_ADAPTER_ID}-${seed}` : stableSourceID(CZ_CUZK_ADAPTER_ID, aligned),
		corpus_version: "",
		license: CZ_CUZK_LICENSE,
	}
}

/**
 * Every archive under `inputPath`, which is one `.zip` or a directory holding them.
 *
 * A directory is read because ČÚZK publishes 6,258 of these, one per municipality,
 * and a caller harvesting the country points at the directory it fetched them into.
 * A directory holding no archive raises rather than yielding zero rows, so a wrong
 * path reports itself instead of reading as an empty publisher.
 */
async function archivePaths(inputPath: PathBuilderLike): Promise<readonly PathBuilderLike[]> {
	const path = PathBuilder.from(inputPath)

	if (path.basename().toLowerCase().endsWith(".zip")) return [path]

	const names = await Globerator.from("*.zip", { cwd: path.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${CZ_CUZK_ADAPTER_ID} adapter: ${path.toString()} holds no .zip archive`)
	}

	return names.map((name) => path(name))
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const czCuzkAdapter = createCzCuzkAdapter()
