/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   New Zealand postcodes: four digits, after the town/city on the last line (`Timaru 7942`).
 *   Verbatim from NZ Post's Address Standards (ADV358, Oct 2021, accessed 2026-06-11): "Postcode is
 *   mandatory and is four digits. It follows the city or town." Note NZ has no state/region line —
 *   "The province, region, district or territory is not to be used."
 *
 *   The shape collides with Australia's (also 4 digits) — `candidateSystemsForPostcode` returns both,
 *   by design (shape test, not membership test).
 * @see {@link https://www.nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf NZ Post Address Standards (ADV358, Oct 2021)}
 */

import type { Tagged } from "type-fest"

/**
 * A New Zealand postcode: four digits.
 *
 * @category Postal
 * @type string
 * @title New Zealand postcode
 * @pattern ^\d{4}$
 */
export type NzPostcode = Tagged<string, "NzPostcode">

/** The NZ postcode shape: exactly four digits. */
export const NZ_POSTCODE_PATTERN = /^\d{4}$/

/** Normalize a postcode surface form (trim only — NZ has no country-prefix courtesy form). */
export function normalizeNzPostcode(raw: unknown): NzPostcode | null {
	if (typeof raw !== "string") return null
	const s = raw.trim()

	return NZ_POSTCODE_PATTERN.test(s) ? (s as NzPostcode) : null
}

/** Type-predicate for a (normalized) New Zealand postcode. */
export function isNzPostcode(input: unknown): input is NzPostcode {
	return typeof input === "string" && NZ_POSTCODE_PATTERN.test(input)
}
