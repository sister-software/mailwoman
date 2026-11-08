// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The one record every address-source adapter emits, and the key-table builder reads.
 */

import type { ADMIN_HIERARCHY_TAGS } from "@mailwoman/codex/component"

import { type NameKey, normalizeLocalityForKey, type RouteKey, type StreetKey } from "#street/normalize"

/**
 * The hierarchy level a place name on an address record states, as the encoder model tags it.
 *
 * A record stores its postcode in {@link AddressRecord.postcode}, so `postcode` is never a name's level.
 */
export type AddressNameLevel = Exclude<(typeof ADMIN_HIERARCHY_TAGS)[number], "postcode">

/**
 * How an adapter arrived at a place name.
 */
export const AddressNameForm = {
	/**
	 * The publisher's own value, such as NAD's `Inc_Muni` `Town of Madison`.
	 */
	Written: "written",
	/**
	 * The written municipality without its legal-form words, such as `Madison` from `Town of Madison`,
	 * or the city an arrondissement belongs to, such as `Paris` from `Paris 3e Arrondissement`.
	 *
	 * The per-source table of those words is data, never a branch in the adapter.
	 */
	Bare: "bare",
	/**
	 * The postal city the publisher states, such as NAD's `Post_City`, or the postcode
	 * gazetteer's city for the record's postcode.
	 */
	Postal: "postal",
} as const

export type AddressNameForm = (typeof AddressNameForm)[keyof typeof AddressNameForm]

/**
 * One place name on an address record.
 */
export interface AddressName {
	level: AddressNameLevel
	form: AddressNameForm
	/**
	 * The name as the record states it, kept for display.
	 */
	value: string
	/**
	 * Shared `normalizeLocalityForKey` of `value`, the form a key table stores and a lookup probes.
	 */
	key: NameKey
}

/**
 * Collects a record's names in the order an adapter states them.
 *
 * Each value is trimmed and keyed with `normalizeLocalityForKey`.
 * A value whose key is empty, or whose level and key an earlier name already holds, is skipped.
 */
export function collectAddressNames(): {
	names: AddressName[]
	add(level: AddressNameLevel, form: AddressNameForm, value: string | null | undefined): void
} {
	const names: AddressName[] = []
	const seen = new Set<string>()

	return {
		names,
		add(level, form, value) {
			const trimmed = value?.trim()

			if (!trimmed) return

			const key = normalizeLocalityForKey(trimmed)
			const identity = `${level}|${key}`

			if (!key || seen.has(identity)) return

			seen.add(identity)
			names.push({ level, form, value: trimmed, key })
		},
	}
}

/**
 * One address point from one source, with every name tagged by its hierarchy level.
 *
 * Two sources' records for one address stay two records.
 * The reader returns both with their sources.
 */
export interface AddressRecord {
	/**
	 * The wire source id the register maps, such as `usgov-nad` or `openaddresses:us/wi/statewide`.
	 */
	source: string
	/**
	 * The publisher's own id for the point, such as NAD's normalized `UUID`.
	 *
	 * An adapter whose publisher states none writes a digest of the rendered address.
	 */
	sourceRecordID: string
	/**
	 * The ISO 3166-1 alpha-2 code of the country the point lies in.
	 */
	country: string
	/**
	 * The ISO 3166-2 code of the first-level subdivision the point lies in, such as `US-WI`
	 * or `FR-IDF`, or `null` when the source states none.
	 *
	 * A country large enough to be split is written one file per subdivision.
	 */
	subdivision: string | null
	/**
	 * The house number lower-cased and kept as text, since `123-A` and `12 1/2` are numbers.
	 */
	number: string
	unit: string | null
	/**
	 * The street as the publisher writes it, kept for display.
	 */
	streetRaw: string
	streetKey: StreetKey
	routeKey: RouteKey
	postcode: string | null
	/**
	 * Every place name the record states or an adapter derived, at every level, in no fixed order.
	 *
	 * A level may hold several names, such as a municipality's written and bare forms.
	 */
	names: readonly AddressName[]
	/**
	 * The publisher's own code for the municipality, such as BAN's `code_insee` (`75103`),
	 * or `null` when the publisher states none.
	 *
	 * The key-table build joins it to the Who's On First place that holds the same code.
	 */
	adminCode: string | null
	lat: number
	lon: number
	/**
	 * How the publisher placed the point, such as NAD's `Placement` (`Structure - Rooftop`),
	 * or `null` when unstated.
	 */
	placement: string | null
	/**
	 * The authority that assigned the address, such as NAD's `AddAuth` (`co.adams.wi.us`),
	 * or `null` when unstated.
	 */
	authority: string | null
}
