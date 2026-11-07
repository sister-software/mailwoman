/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one record every address-source adapter emits, and the key-table builder reads.
 */

import type { ADMIN_HIERARCHY_TAGS } from "@mailwoman/codex/component"

import type { NameKey, RouteKey, StreetKey } from "#street/normalize"

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
	 * The written municipality without its legal-form words, such as `Madison` from `Town of Madison`.
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
