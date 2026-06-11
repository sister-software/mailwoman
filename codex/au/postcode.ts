/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australian postcodes: four digits, written at the end of the last address line after the
 *   locality and state (`SYDNEY NSW 2000`). Sourcing (accessed 2026-06-11):
 *
 *   - Australia Post's Correct Addressing brochure (SAP 8833878, Nov 2022) — every example carries a
 *       4-digit postcode and the brochure references envelopes "with preprinted four postcode
 *       squares".
 *   - The barcode addressing booklet documents the coarse first-digit → state prior: "if the
 *       Postcode falls in the range 3000-3999 the State abbreviation will be VIC; 4000-4999 will be
 *       QLD, etc. … Exceptions to this include ACT Postcodes and Postcodes located on State
 *       borders." Because the booklet only enumerates VIC and QLD and flags exceptions, this module
 *       deliberately does NOT ship a full first-digit → state table — the shape is the contract, the
 *       geographic prior is the gazetteer's job.
 *
 *   Note the shape collides with New Zealand's (also 4 digits) — `candidateSystemsForPostcode`
 *   returns both, and that ambiguity is by design (shape test, not membership test).
 *
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/correct-addressing.pdf Australia Post Correct Addressing brochure (Nov 2022)}
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf Australia Post barcode addressing booklet}
 */

import type { Tagged } from "type-fest"

/**
 * An Australian postcode: four digits.
 *
 * @category Postal
 * @type string
 * @title Australian postcode
 * @pattern ^\d{4}$
 */
export type AuPostcode = Tagged<string, "AuPostcode">

/** The AU postcode shape: exactly four digits. */
export const AU_POSTCODE_PATTERN = /^\d{4}$/

/** Normalize a postcode surface form (trim only — AU has no country-prefix courtesy form). */
export function normalizeAuPostcode(raw: unknown): AuPostcode | null {
	if (typeof raw !== "string") return null
	const s = raw.trim()
	return AU_POSTCODE_PATTERN.test(s) ? (s as AuPostcode) : null
}

/** Type-predicate for a (normalized) Australian postcode. */
export function isAuPostcode(input: unknown): input is AuPostcode {
	return typeof input === "string" && AU_POSTCODE_PATTERN.test(input)
}
