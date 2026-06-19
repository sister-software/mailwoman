/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   US ZIP (Zone Improvement Plan) codes: branded string types, the shape patterns, the first-digit →
 *   state geographic prior, and a state-plus-ZIP plucker.
 */

import type { Tagged } from "type-fest"
import { isUsStateAbbreviation, type UsStateAbbreviation } from "./state.js"

/**
 * USPS-recognized ZIP code digits.
 *
 * @internal
 */
export type ZipCodeDigit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/**
 * A ZIP (Zone Improvement Plan) Code is a five-digit code assigned by the USPS to a section of a
 * street, a collection of streets, an establishment, structure, or group of post office boxes, for
 * the delivery of mail.
 *
 * - The first 3 digits of the ZIP code represent a specific central mail processing facility, which
 *   can be used to identify the locality and region of the address, i.e. the city and state.
 * - The last 2 digits of the ZIP code represent a specific post office or delivery area.
 *
 * ```txt
 *        90210
 *       / |⎿__(Post Office)
 *      /   \
 *  (State)  \
 *            \
 *           (City)
 * ```
 *
 * Note that ZIP codes are not truly areas, but rather a group of deliverable addresses, which can
 * and do change over time.
 *
 * @category Delivery
 * @category Postal
 * @see {@linkcode ZipCodePlusFour} for the extended ZIP code format.
 * @title ZIP Code
 * @pattern ^\d{5}$
 */
export type ZipCode = Tagged<string, "ZipCode">

/**
 * The extended ZIP code format includes the five-digit ZIP code followed by a hyphen and four
 * additional digits. This extended format is used to provide more precise location information.
 *
 * - The first 3 digits of the ZIP code represent a specific central mail processing facility,
 * - The last 2 digits of the ZIP code represent a specific post office or delivery area.
 * - The four additional digits represent a specific delivery route within the ZIP code area.
 *
 * ```txt
 *                  90210-1234
 *                  \_/\ /\__/
 *                  /   |    \
 *  (State, City)_ /    |     \_ (Delivery Route)
 *                      |
 *                (Post Office)
 * ```
 *
 * Note that ZIP codes are not truly areas, but rather a group of deliverable addresses, which can
 * and do change over time.
 *
 * @category Delivery
 * @category Postal
 * @type string
 * @see {@linkcode ZipCode} for the standard ZIP code format.
 * @title ZIP Code+4
 * @pattern ^\d{5}-\d{4}$
 */
export type ZipCodePlusFour = Tagged<string, "ZipCodePlusFour">

/**
 * Type utility to extract the state abbreviation from a ZIP code.
 *
 * @internal
 */
export type ExtractStateFromZipCode<Zip extends ZipCode | ZipCodePlusFour> =
	Zip extends `${infer StateCode}${infer _Rest}` ? StateCode : never

/**
 * Record of US state abbreviations to their corresponding ZIP code prefix (the leading digit). A
 * cheap geographic prior: a 5-digit code's first digit narrows it to a band of states, which the
 * parser can weigh against the surrounding city/state tokens.
 *
 * @see {@linkcode ZipCodePrefixAbbreviationMap} for the reverse mapping.
 * @internal
 */
export const StateAbbreviationZipCodePrefixRecord = {
	AL: 3,
	AK: 9,
	AZ: 8,
	AR: 7,
	CA: 9,
	CO: 8,
	CT: 0,
	DE: 1,
	DC: 2,
	FL: 3,
	GA: 3,
	HI: 9,
	ID: 8,
	IL: 6,
	IN: 4,
	IA: 5,
	KS: 6,
	KY: 4,
	LA: 7,
	ME: 0,
	MD: 2,
	MA: 0,
	MI: 4,
	MN: 5,
	MS: 3,
	MO: 6,
	MT: 5,
	NE: 6,
	NV: 8,
	NH: 0,
	NJ: 0,
	NM: 8,
	NY: 1,
	NC: 2,
	ND: 5,
	OH: 4,
	OK: 7,
	OR: 9,
	PA: 1,
	RI: 0,
	SC: 2,
	SD: 5,
	TN: 3,
	TX: 7,
	UT: 8,
	VT: 0,
	VA: 2,
	WA: 9,
	WV: 2,
	WI: 5,
	WY: 8,
	PR: 0,
	GU: 9,
	VI: 0,
	MP: 9,
	AS: 9,
} as const satisfies Record<UsStateAbbreviation, ZipCodeDigit>

/**
 * Map of ZIP code prefixes to their corresponding US state abbreviations.
 */
const ZipCodePrefixAbbreviationMap = new Map<ZipCodeDigit, UsStateAbbreviation[]>()

for (const [state, prefix] of Object.entries(StateAbbreviationZipCodePrefixRecord) as [
	UsStateAbbreviation,
	ZipCodeDigit,
][]) {
	const states = ZipCodePrefixAbbreviationMap.get(prefix) ?? []
	ZipCodePrefixAbbreviationMap.set(prefix, [...states, state])
}

export { ZipCodePrefixAbbreviationMap }

/**
 * Regex patterns for ZIP codes.
 */
export const ZipCodePatterns = {
	/**
	 * 5-digit, or 9-digit ZIP code or ZIP+4 code.
	 */
	Standard: /^\d{5}(?:[-\s]\d{4})?$/,

	/**
	 * Two-letter state abbreviation followed by a 5-digit ZIP code or ZIP+4 code.
	 */
	StateAbbreviationWithZipCode: /^(?:([A-Za-z]{2})[ ,]*)?([0-9]{5}(?:[-\s][0-9]{4})?)$/,
} as const

/**
 * Type-predicate to determine if a value is a valid ZIP code.
 */
export function isZipCode(input: unknown): input is ZipCode | ZipCodePlusFour {
	return typeof input === "string" && ZipCodePatterns.Standard.test(input)
}

export interface PluckedStateZIPCodeResult {
	stateAbbreviation: UsStateAbbreviation | null
	zipCode: ZipCode | ZipCodePlusFour
}

/**
 * Given an address string like `"NY"`, `"CA 94016"`, attempts to match the state abbreviation and
 * postal code, if applicable.
 *
 * @see {@linkcode isUsStateAbbreviation} to validate the state abbreviation.
 */
export function pluckStateZIPCode(input: unknown): PluckedStateZIPCodeResult | null {
	if (!input || typeof input !== "string") return null

	const [, stateAbbreviation, zipCode = null] = input.match(ZipCodePatterns.StateAbbreviationWithZipCode) || []

	if (!zipCode) return null

	const normalizedState = stateAbbreviation?.toUpperCase()

	return {
		stateAbbreviation: isUsStateAbbreviation(normalizedState) ? normalizedState : null,
		zipCode: zipCode as ZipCode | ZipCodePlusFour,
	}
}
