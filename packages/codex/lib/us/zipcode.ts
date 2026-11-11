/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines US ZIP (Zone Improvement Plan) string types and validation patterns.
 *   It also defines the first-digit state prior and a state-plus-ZIP plucker.
 */

import type { Tagged } from "type-fest"

import { isUSStateAbbreviation, type USStateAbbreviation } from "#us/state"

/**
 * USPS-recognized ZIP code digits.
 *
 * @internal
 */
export type ZipCodeDigit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/**
 * A ZIP (Zone Improvement Plan) Code is a five-digit code assigned by the USPS to
 * a section of a street, a collection of streets, an establishment, structure,
 * or group of post office boxes, for the delivery of mail.
 *
 * - The first three digits identify a central mail processing facility.
 *   They can help identify the address's city and state.
 * - The last 2 digits of the ZIP code represent a specific post office or delivery area.
 *
 * ```txt
 *        90210
 *       / |⎿__(Post Office)
 *      /   \
 *  (State) \
 *            \
 *           (City)
 * ```
 *
 * A ZIP code identifies a group of deliverable addresses rather than a geographic area.
 * The group can change over time.
 *
 * @category Delivery
 * @category Postal
 * @title ZIP Code
 * @pattern ^\d{5}$
 * @see {@linkcode ZipCodePlusFour} for the extended ZIP code format.
 */
export type ZipCode = Tagged<string, "ZipCode">

/**
 * The extended ZIP code format includes the five-digit ZIP code followed by a hyphen
 * and four additional digits.
 *
 * This extended format is used to provide more precise location information.
 *
 * - The first 3 digits of the ZIP code represent a specific central mail processing facility,
 * - The last 2 digits of the ZIP code represent a specific post office or delivery area.
 * - The four additional digits represent a specific delivery route within the ZIP code area.
 *
 * ```txt
 *                  90210-1234
 *                  \_/\ /\__/
 *                  /   |    \
 *  (State, City)_ / | \_ (Delivery Route)
 *                      |
 *                (Post Office)
 * ```
 *
 * A ZIP code identifies a group of deliverable addresses rather than a geographic area.
 * The group can change over time.
 *
 * @category Delivery
 * @category Postal
 * @type string
 * @title ZIP Code+4
 * @pattern ^\d{5}-\d{4}$
 * @see {@linkcode ZipCode} for the standard ZIP code format.
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
 * Record of US state abbreviations to their corresponding ZIP code prefix (the leading digit).
 *
 * A cheap geographic prior.
 * The first digit of a five-digit code narrows it to a band of states.
 *
 * The parser weighs that band against the surrounding city and state tokens.
 *
 * @internal
 * @see {@linkcode ZipCodePrefixAbbreviationMap} for the reverse mapping.
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
} as const satisfies Record<USStateAbbreviation, ZipCodeDigit>

/**
 * Map of ZIP code prefixes to their corresponding US state abbreviations.
 */
const ZipCodePrefixAbbreviationMap = new Map<ZipCodeDigit, USStateAbbreviation[]>(
	[
		...Map.groupBy(
			Object.entries(StateAbbreviationZipCodePrefixRecord) as [USStateAbbreviation, ZipCodeDigit][],
			([, prefix]) => prefix
		),
	].map(([prefix, entries]) => [prefix, entries.map(([state]) => state)])
)

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

/**
 * A published postcode for an address in `state`, as a five-digit ZIP Code
 * or ZIP+4, or `null` when the value isn't one.
 *
 * Sources write the same code several ways, and each is read back to it:
 * - a ZIP+4 with no separator, `368010028`, is `36801-0028`;
 * - a number written with a zero fraction, `19311.0`, is `19311`;
 * - five digits followed by an empty or broken `+4` or a stray character,
 *   `35175-` or `76442-*`, keep the five.
 *
 * A source that stored the code as a number dropped its leading zeros, so a value two
 * or four digits short of a ZIP Code or ZIP+4 that doesn't begin with zero is padded back.
 * The padded code is kept only when its first digit is the state's
 * ({@linkcode StateAbbreviationZipCodePrefixRecord}): Puerto Rico's `612` is `00612`,
 * and Texas's `7341` is `null`.
 *
 * A short value that already begins with zero lost its trailing digits rather than its
 * leading zeros, so it's `null`, as is a placeholder such as `0`, `-`, `N/A` or a city name.
 */
export function normalizeZIPCode(value: string | null, state: USStateAbbreviation): string | null {
	const trimmed = value?.trim().replace(/\.0+$/u, "")

	if (!trimmed) return null

	if (isZipCode(trimmed)) return trimmed

	if (/^\d{9}$/u.test(trimmed)) return `${trimmed.slice(0, 5)}-${trimmed.slice(5)}`

	const leadingFive = /^(\d{5})\D/u.exec(trimmed)

	if (leadingFive) return leadingFive[1]!

	const short = /^[1-9](?:\d{2,3}|\d{6,7})$/u.exec(trimmed)

	if (!short) return null

	const target = trimmed.length < ZIP_CODE_DIGITS ? ZIP_CODE_DIGITS : ZIP_PLUS_FOUR_DIGITS
	const padded = trimmed.padStart(target, "0")

	if (Number(padded[0]) !== StateAbbreviationZipCodePrefixRecord[state]) return null

	return target === ZIP_PLUS_FOUR_DIGITS
		? `${padded.slice(0, ZIP_CODE_DIGITS)}-${padded.slice(ZIP_CODE_DIGITS)}`
		: padded
}

/**
 * The digits in a ZIP Code.
 */
const ZIP_CODE_DIGITS = 5

/**
 * The digits in a ZIP+4 written without its hyphen.
 */
const ZIP_PLUS_FOUR_DIGITS = 9

export interface PluckedStateZIPCodeResult {
	stateAbbreviation: USStateAbbreviation | null
	zipCode: ZipCode | ZipCodePlusFour
}

/**
 * Given an address string like `"NY"`, `"CA 94016"`, attempts to match the state
 * abbreviation and postcode, if applicable.
 *
 * @see {@linkcode isUSStateAbbreviation} to validate the state abbreviation.
 */
export function pluckStateZIPCode(input: unknown): PluckedStateZIPCodeResult | null {
	if (!input || typeof input !== "string") return null

	const [, stateAbbreviation, zipCode = null] = input.match(ZipCodePatterns.StateAbbreviationWithZipCode) || []

	if (!zipCode) return null

	const normalizedState = stateAbbreviation?.toUpperCase()

	return {
		stateAbbreviation: isUSStateAbbreviation(normalizedState) ? normalizedState : null,
		zipCode: zipCode as ZipCode | ZipCodePlusFour,
	}
}
