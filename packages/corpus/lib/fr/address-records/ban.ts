/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emits BAN, the French national address register, as address records for the address layer's key tables.
 */

import { type BANAddrRecord, extractBANAddrPoints } from "@mailwoman/ban/sdk/extract"
import { streetLocaleForBANCountry } from "@mailwoman/ban/street-locale"
import { departementInfo } from "@mailwoman/codex/fr/departement"
import {
	AddressNameForm,
	type AddressName,
	type AddressNameLevel,
	type AddressRecord,
} from "@mailwoman/resolver-wof-sqlite/address/record"
import {
	canonicalizeRouteKey,
	normalizeHouseNumberForKey,
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
} from "@mailwoman/resolver-wof-sqlite/street/normalize"
import type { PathBuilderLike } from "path-ts"

import { rawTextDiscriminator } from "#adapters/record-id"
import { countryOfInseeCode } from "#fr/insee-country"

/**
 * The wire source id the BAN address-point database writes on every row.
 */
export const BAN_ADDRESS_SOURCE = "ban:fr"

const STREET_LOCALE = streetLocaleForBANCountry("fr")

/**
 * An arrondissement's commune name, such as `Paris 3e Arrondissement` or `Lyon 1er Arrondissement`.
 * The first group is the city the arrondissement belongs to.
 */
const ARRONDISSEMENT = /^(.+?)\s+\d+(?:er|e)\s+arrondissement$/iu

/**
 * The city an arrondissement's commune belongs to, or `null` for a commune that is not an arrondissement.
 */
export function arrondissementCity(commune: string): string | null {
	return ARRONDISSEMENT.exec(commune.trim())?.[1] ?? null
}

/**
 * The ISO 3166-2 code of a metropolitan commune's région, such as `FR-IDF` for INSEE
 * `75103`, read from the département its code opens with.
 *
 * An overseas commune lies in its own ISO 3166-1 country, so it has none.
 */
export function banSubdivision(country: string, codeInsee: string | null): string | null {
	// country-branch: the département-to-région table is metropolitan France's,
	// and BAN's overseas rows are ISO countries of their own.
	if (country !== "FR" || !codeInsee) return null

	const region = departementInfo(codeInsee.trim().slice(0, 2))?.region

	return region ? `FR-${region}` : null
}

/**
 * Every place name in a BAN row, by level.
 *
 * `nom_commune` is the written locality, with the city beside it when the commune is an arrondissement.
 * `libelle_acheminement` is the postal locality and `nom_ancienne_commune` a written locality,
 * since a letter may still be addressed to a merged commune's former name.
 *
 * A cleaned `nom_ld` is a dependent locality.
 * A pair of level and key is kept once, under the first form that produced it.
 */
export function banAddressNames(record: BANAddrRecord): AddressName[] {
	const names: AddressName[] = []

	const add = (level: AddressNameLevel, form: AddressNameForm, value: string | null) => {
		const trimmed = value?.trim()

		if (!trimmed) return
		const key = normalizeLocalityForKey(trimmed)

		if (key && !names.some((name) => name.level === level && name.key === key)) {
			names.push({ level, form, value: trimmed, key })
		}
	}

	add("locality", AddressNameForm.Written, record.city)
	add("locality", AddressNameForm.Bare, record.city ? arrondissementCity(record.city) : null)
	add("locality", AddressNameForm.Postal, record.postalCity)
	add("locality", AddressNameForm.Written, record.formerCommune)
	add("dependent_locality", AddressNameForm.Written, record.lieuDit)

	return names
}

/**
 * The address record for one BAN row.
 *
 * The house number joins `numero` and `rep` (`8 bis`), so it keys the way a parsed number does.
 * The country is the commune's own ISO 3166-1 code, so a Guadeloupe address lies in `GP`.
 */
export function banAddressRecord(record: BANAddrRecord): AddressRecord | null {
	const numero = record.numero.trim()
	const streetKey = normalizeStreetForKeyLocale(record.street, STREET_LOCALE)

	if (!numero || !streetKey) return null

	const number = normalizeHouseNumberForKey(record.rep ? `${numero} ${record.rep}` : numero, STREET_LOCALE)
	const country = countryOfInseeCode(record.codeInsee ?? "")

	return {
		source: BAN_ADDRESS_SOURCE,
		sourceRecordID: record.id ?? `digest:${rawTextDiscriminator(`${number} ${record.street} ${record.codeInsee}`)}`,
		country,
		subdivision: banSubdivision(country, record.codeInsee),
		number,
		unit: null,
		streetRaw: record.street,
		streetKey,
		routeKey: canonicalizeRouteKey(streetKey),
		postcode: record.postcode,
		names: banAddressNames(record),
		adminCode: record.codeInsee,
		lat: record.lat,
		lon: record.lon,
		placement: record.positionType,
		authority: null,
	}
}

/**
 * Streams the address records of one BAN département dump, `adresses-<code>.csv` or its `.csv.gz`.
 */
export async function* readBANAddressRecords(csvPath: PathBuilderLike): AsyncGenerator<AddressRecord> {
	for await (const row of extractBANAddrPoints(csvPath)) {
		const record = banAddressRecord(row)

		if (record) {
			yield record
		}
	}
}
