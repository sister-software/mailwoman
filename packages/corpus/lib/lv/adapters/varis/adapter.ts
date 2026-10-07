/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `lv-varis`: Latvia's State Address Register (`Valsts adrešu reģistrs`), read from the open data
 * Valsts zemes dienests publishes as the data.gov.lv dataset `varis-atvertie-dati`.
 *
 * Input is the directory `fetchVaris` writes: six of the dataset's CSV tables, each under the file
 * name the portal serves it as, `aw_eka.csv` and the five tables its parent codes point into. Every table is
 * UTF-8 with a byte-order mark, comma-separated, and quotes every field, doubling a quote inside a
 * value. The column metadata the publisher posts beside each table declares `ISO-8859-1`; the bytes
 * are UTF-8, and the reader decodes them as UTF-8. Over the 2026-09-30 edition no value in
 * `aw_eka.csv` holds a line break, 0 of 610,876 records.
 *
 * ## One row per building or land-unit address
 *
 * `aw_eka.csv` holds the addresses of buildings and of land units intended for building, one record
 * per address. Of its 610,876 records, `STATUSS` is `EKS` (existing) on 550,652, `DEL` (removed) on
 * 32,448 and `ERR` (erroneous) on 27,776. Only `EKS` records become rows. The two other states are
 * counted under {@linkcode VarisRefusal}.
 *
 * Each record names its immediate parent by `VKUR_CD` and `VKUR_TIPS`, and the parent names its own
 * the same way, up to the country. The type codes are the register's: `104` city (`pilsēta`), `105`
 * parish (`pagasts`), `106` village (`ciems`), `107` street (`iela`), `113` municipality (`novads`)
 * and `101` Latvia. No table read lists its code `100000000` as a row. Over the 550,652 active records the
 * chains take seven shapes, written from the parent upward. The rows column counts what the adapter
 * emits after the refusals below:
 *
 * | Chain                         | Records |    Rows | {@linkcode VarisAddressType}  |
 * | ----------------------------- | ------: | ------: | ----------------------------- |
 * | parish, municipality          | 116,225 | 116,225 | `ParishNamedHouse`          |
 * | street, city, municipality    | 113,906 | 113,905 | `TownStreet`                 |
 * | street, city                  | 111,218 | 111,217 | `StateCityStreet`           |
 * | village, parish, municipality | 108,164 | 108,164 | `VillageNamedHouse`         |
 * | street, village, parish, mun. |  98,192 |  98,179 | `VillageStreet`              |
 * | city, municipality            |   2,814 |   2,814 | `CityNamedHouse`            |
 * | city                          |     133 |     133 | `CityNamedHouse`            |
 *
 * No active record has an unresolved or inactive ancestor, 0 of 550,652.
 *
 * ## The written form is the publisher's
 *
 * `STD` holds the register's own full address string: `Krišjāņa Barona iela 1, Rīga, LV-1050` or
 * `"Riņņi", Vecates pag., Valmieras nov., LV-4211`. Each
 * part is the `NOSAUKUMS` of one object in the chain, in chain order, joined by a comma and a space,
 * with the postcode `ATRIB` last. A building on a street writes the street name and the house number
 * as one part, and a building with its own name writes it inside ASCII double quotes. The adapter composes
 * that string from the chain and compares it with `STD`. Over the 550,637 active records the adapter
 * does not refuse first, the two are equal on 550,637. A record where they differ is refused, so every
 * row's `raw` is `STD` unchanged and every component's position in it is known. The row's surface is
 * `attested`. `alignRow` aligns the 550,637 rows at edit distance 0, quarantines none, and places
 * every component in the order above.
 *
 * The comparison reads values as stored. 25 building names end in a space, and `STD` keeps it inside the
 * quotes, `"Vilidža "`, so the reader turns off the CSV reader's trimming, composes from the stored
 * values and trims only the labels.
 *
 * The codex renderer cannot produce this order. libaddressinput's Latvian layout prints the region
 * line before the locality, `Siguldas nov., Sigulda, LV-2150`, where the register writes `Sigulda,
 * Siguldas nov., LV-2150`, so `formatAddressRow` is not called.
 *
 * ## Which tag each part takes
 *
 * - The street's `NOSAUKUMS` is `street`, type word included: `Brīvības iela`, `Vidusceļš`. No Latvian
 *   street-type split exists in this repository, and the register stores the name whole.
 * - The house number is `house_number`, its building-block suffix included: `195 k-1` is house 195,
 *   block (`korpuss`) 1, one address in the register. Over the 323,316 street addresses, 249,783 are
 *   bare digits and 56,374 digits and a letter. 15 hold no digit, such as `Bauskas iela Ozoli`, where
 *   a house name stands in the number's place. Those are refused, because the name is not a number
 *   and labeling it a venue would place a venue after a street. No other Latvian row does that.
 * - A building's name is `venue`. SCHEMA.mdx defines `venue` as a place with a name and keeps
 *   `building_name` for Japan, and the Estonian register adapter labels a farm name `venue` for the same
 *   reason. The quotes are punctuation and lie outside the span. 236 names hold a quote of their own,
 *   such as `Stacija "Biksti"`, which the register writes `"Stacija "Biksti""`.
 * - A city and a parish are `locality`. Both are direct parts of a municipality, so they are the same
 *   tier, and a rural address without a village still writes the parish it lies in. The
 *   parish is written with the register's abbreviation, `Vecates pag.`, and the span includes it, as a
 *   `subregion` of `Multnomah County` includes `County`.
 * - A village is `dependent_locality`. It lies inside a parish, and the Estonian adapter labels a
 *   village inside a rural municipality the same way.
 * - A municipality is `region`, abbreviation included: `Valmieras nov.`. The register holds no tier
 *   above it: the parent of all 35 active municipalities is Latvia. The 7 active cities whose parent is
 *   Latvia, the state cities such as Rīga and Daugavpils, write no municipality, so their rows have no
 *   region.
 * - `ATRIB` is `postcode`, prefix included: `LV-4211`.
 *
 * ## Premises and apartments
 *
 * The register's premises table, `aw_dziv.csv`, holds 868,669 active apartment and premises addresses
 * in 57,285 buildings, more than the 550,652 building addresses. A tenth of those buildings hold 50.1%
 * of the apartments, and one building holds 681. Rows for every apartment would make a few large blocks
 * the commonest Latvian address, so the adapter reads no premises.
 *
 * ## Personal data, identity and license
 *
 * The register records places and names no owner or occupant, so no row has a natural person's
 * name. A building name is the name of the property, as on a map.
 *
 * The row id is the register's own object code, `lv-varis-<KODS>`. Five `STD` strings are each written
 * by two codes, so two rows can share a `raw` while their ids differ.
 *
 * data.gov.lv publishes the dataset under `CC-BY-4.0`, the `license_id` its CKAN record names for the
 * publisher Valsts zemes dienests, and the column metadata posted beside `aw_dziv.csv` names
 * `https://creativecommons.org/licenses/by/4.0/` as `dc:license`. CC BY 4.0 requires credit, a link to the license and
 * a statement that changes were made, so every row records the license and
 * {@linkcode LV_VARIS_ATTRIBUTION} is the credit the model card states.
 *
 * The adapter honors `opts.limit` and `opts.signal`. `opts.country` is optional and accepts only `LV`.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { PathBuilderLike } from "path-ts"
import { PathBuilder } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { SourceRegister } from "#registers"
import {
	AddressRole,
	type AdapterOptions,
	type CanonicalRow,
	type CorpusAdapter,
	countDropped,
	SurfaceOrigin,
} from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits.
 */
export const LV_VARIS_ADAPTER_ID = "lv-varis"

/**
 * The one jurisdiction this adapter emits.
 */
export const LV_VARIS_COUNTRIES: readonly string[] = ["LV"]

/**
 * The license data.gov.lv names for the dataset.
 */
export const LV_VARIS_LICENSE = "CC-BY-4.0"

/**
 * The credit CC BY 4.0 obliges.
 */
export const LV_VARIS_ATTRIBUTION = "Valsts zemes dienests, Valsts adrešu reģistra atvērtie dati, via data.gov.lv"

/**
 * The register tables the adapter reads, by the file name the portal serves each under.
 */
export const VARIS_TABLES = {
	Building: "aw_eka.csv",
	Street: "aw_iela.csv",
	Village: "aw_ciems.csv",
	Parish: "aw_pagasts.csv",
	Municipality: "aw_novads.csv",
	City: "aw_pilseta.csv",
} as const

export type VarisTable = (typeof VARIS_TABLES)[keyof typeof VARIS_TABLES]

/**
 * The register's addressing-object type codes, `TIPS_CD` and `VKUR_TIPS`.
 */
export const VarisObjectType = {
	Country: "101",
	City: "104",
	Parish: "105",
	Village: "106",
	Street: "107",
	Building: "108",
	Municipality: "113",
} as const

export type VarisObjectType = (typeof VarisObjectType)[keyof typeof VarisObjectType]

/**
 * The status the register writes on an existing address.
 */
const ACTIVE = "EKS"

/**
 * Why a building record did not become a row.
 */
export const VarisRefusal = {
	/**
	 * `STATUSS` is `DEL`: the address was removed.
	 */
	Removed: "row:status-removed",
	/**
	 * `STATUSS` is `ERR`: the register marks the address erroneous.
	 */
	Erroneous: "row:status-erroneous",
	/**
	 * `STATUSS` holds a value the register's documentation does not list.
	 */
	UnknownStatus: "row:status-unknown",
	/**
	 * A code in the parent chain names no object in the tables read.
	 */
	ParentUnresolved: "row:parent-unresolved",
	/**
	 * An object in the parent chain is not active.
	 */
	AncestorInactive: "row:ancestor-inactive",
	/**
	 * The chain holds an object type in a place no address shape allows.
	 */
	UnexpectedHierarchy: "row:unexpected-hierarchy",
	/**
	 * The record has no `LV-` postcode.
	 */
	PostcodeAbsent: "row:postcode-absent",
	/**
	 * A building on a street has a name with no digit where its number belongs.
	 */
	NamedHouseOnStreet: "row:named-house-on-street",
	/**
	 * The string composed from the chain differs from the register's `STD`.
	 */
	StandardFormMismatch: "row:standard-form-mismatch",
} as const

export type VarisRefusal = (typeof VarisRefusal)[keyof typeof VarisRefusal]

/**
 * The shape of an address, read from its parent chain.
 */
export const VarisAddressType = {
	/**
	 * A street address in one of the state cities.
	 * Those cities lie under no municipality.
	 */
	StateCityStreet: "state-city-street",
	/**
	 * A street address in a town of a municipality.
	 */
	TownStreet: "town-street",
	/**
	 * A street address in a village.
	 */
	VillageStreet: "village-street",
	/**
	 * A house with its own name in a city, on no street.
	 */
	CityNamedHouse: "city-named-house",
	/**
	 * A house with its own name in a village.
	 */
	VillageNamedHouse: "village-named-house",
	/**
	 * A house with its own name in a parish, in no village.
	 */
	ParishNamedHouse: "parish-named-house",
} as const

export type VarisAddressType = (typeof VarisAddressType)[keyof typeof VarisAddressType]

/**
 * The columns read from every table.
 */
export interface VarisRecord {
	KODS: string
	TIPS_CD: string
	STATUSS: string
	VKUR_CD: string
	VKUR_TIPS: string
	NOSAUKUMS: string
	ATRIB: string
	STD: string
}

/**
 * One object a building's parent chain passes through.
 */
export interface VarisPlace {
	type: string
	name: string
	parentCode: string
	active: boolean
}

/**
 * The places of the five parent tables, keyed by object code.
 */
export type VarisPlaces = ReadonlyMap<string, VarisPlace>

export type VarisReading =
	| { readonly admitted: CanonicalRow; readonly addressType: VarisAddressType }
	| { readonly refused: VarisRefusal }

const TAG_OF_PLACE: Readonly<Record<string, ComponentTag>> = {
	[VarisObjectType.City]: "locality",
	[VarisObjectType.Parish]: "locality",
	[VarisObjectType.Village]: "dependent_locality",
	[VarisObjectType.Municipality]: "region",
}

/**
 * The object code the register gives Latvia, the parent of every municipality and state city.
 * No table read holds it as a row.
 */
export const VARIS_COUNTRY_CODE = "100000000"

const MAX_CHAIN = 4

const POSTCODE = /^LV-\d{4}$/u

const DIGIT = /\d/u

function refusalOfStatus(status: string): VarisRefusal {
	if (status === "DEL") return VarisRefusal.Removed

	if (status === "ERR") return VarisRefusal.Erroneous

	return VarisRefusal.UnknownStatus
}

function addressTypeOf(parentType: string, chain: readonly VarisPlace[]): VarisAddressType {
	const settlement = parentType === VarisObjectType.Street ? chain[1] : chain[0]
	const underMunicipality = chain.some((place) => place.type === VarisObjectType.Municipality)

	if (parentType === VarisObjectType.Street) {
		if (settlement?.type === VarisObjectType.Village) return VarisAddressType.VillageStreet

		return underMunicipality ? VarisAddressType.TownStreet : VarisAddressType.StateCityStreet
	}

	if (settlement?.type === VarisObjectType.Village) return VarisAddressType.VillageNamedHouse

	if (settlement?.type === VarisObjectType.Parish) return VarisAddressType.ParishNamedHouse

	return VarisAddressType.CityNamedHouse
}

/**
 * Reads one building record into a row or the reason it is refused.
 */
export function readVarisBuilding(record: VarisRecord, places: VarisPlaces): VarisReading {
	if (record.STATUSS !== ACTIVE) return { refused: refusalOfStatus(record.STATUSS) }

	const chain: VarisPlace[] = []

	for (let code = record.VKUR_CD; code !== VARIS_COUNTRY_CODE;) {
		const place = places.get(code)

		if (!place) return { refused: VarisRefusal.ParentUnresolved }

		if (!place.active) return { refused: VarisRefusal.AncestorInactive }

		chain.push(place)

		// The deepest chain is street, village, parish, municipality.
		// A longer one is a cycle.
		if (chain.length > MAX_CHAIN) return { refused: VarisRefusal.UnexpectedHierarchy }

		code = place.parentCode
	}

	if (!chain.length) return { refused: VarisRefusal.ParentUnresolved }

	const postcode = record.ATRIB

	if (!POSTCODE.test(postcode)) return { refused: VarisRefusal.PostcodeAbsent }

	// The parts are composed from the values as stored, because `STD` repeats a stored trailing space.
	// The labels are trimmed.
	const name = record.NOSAUKUMS
	const components: CanonicalRow["components"] = {}
	const parts: string[] = []
	let administrative: readonly VarisPlace[] = chain

	if (chain[0]!.type === VarisObjectType.Street) {
		if (!DIGIT.test(name)) return { refused: VarisRefusal.NamedHouseOnStreet }

		components.street = chain[0]!.name
		components.house_number = name
		parts.push(`${chain[0]!.name} ${name}`)
		administrative = chain.slice(1)
	} else {
		components.venue = name
		parts.push(`"${name}"`)
	}

	for (const place of administrative) {
		const tag = TAG_OF_PLACE[place.type]

		if (!tag || components[tag]) return { refused: VarisRefusal.UnexpectedHierarchy }

		components[tag] = place.name
		parts.push(place.name)
	}

	components.postcode = postcode
	parts.push(postcode)

	const raw = record.STD.normalize("NFC")

	if (parts.join(", ").normalize("NFC") !== raw) return { refused: VarisRefusal.StandardFormMismatch }

	for (const [tag, value] of Object.entries(components)) {
		components[tag as ComponentTag] = value.trim().normalize("NFC")
	}

	return {
		addressType: addressTypeOf(chain[0]!.type, chain),
		admitted: {
			raw,
			components,
			country: "LV",
			locale: "lv-LV",
			source: LV_VARIS_ADAPTER_ID,
			source_id: `${LV_VARIS_ADAPTER_ID}-${record.KODS}`,
			corpus_version: "",
			license: LV_VARIS_LICENSE,
		},
	}
}

/**
 * Streams one table's records, each value as stored.
 *
 * The reader turns trimming off because `STD` keeps a stored trailing space inside a building name's quotes.
 * The composition check compares the two.
 */
export function readVarisTable(path: PathBuilderLike): AsyncIterable<VarisRecord> {
	return CSVSpliterator.fromAsync(path, { normalizeKeys: false, trim: false }) as AsyncIterable<VarisRecord>
}

/**
 * Reads the five parent tables into one map keyed by object code.
 */
export async function readVarisPlaces(directory: PathBuilderLike): Promise<Map<string, VarisPlace>> {
	const dir = PathBuilder.from(directory)
	const places = new Map<string, VarisPlace>()

	for (const table of [
		VARIS_TABLES.Street,
		VARIS_TABLES.Village,
		VARIS_TABLES.Parish,
		VARIS_TABLES.Municipality,
		VARIS_TABLES.City,
	]) {
		for await (const record of readVarisTable(dir(table))) {
			places.set(record.KODS, {
				type: record.TIPS_CD,
				name: record.NOSAUKUMS,
				parentCode: record.VKUR_CD,
				active: record.STATUSS === ACTIVE,
			})
		}
	}

	return places
}

export function createVarisAdapter(): CorpusAdapter {
	return {
		id: LV_VARIS_ADAPTER_ID,
		defaultLicense: LV_VARIS_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.VARIS,
		surface: SurfaceOrigin.Attested,
		description:
			"Latvia's State Address Register: every active building and land-unit address, as the register writes it.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !LV_VARIS_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(LV_VARIS_ADAPTER_ID, LV_VARIS_COUNTRIES, opts.country)
			}

			const dir = PathBuilder.from(opts.inputPath)
			const places = await readVarisPlaces(dir)
			let emitted = 0

			for await (const record of readVarisTable(dir(VARIS_TABLES.Building))) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const reading = readVarisBuilding(record, places)

				if ("refused" in reading) {
					countDropped(opts, reading.refused)

					continue
				}

				yield reading.admitted

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const varisAdapter = createVarisAdapter()
