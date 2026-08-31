/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Italian postcodes (Codice di Avviamento Postale, CAP): the branded type and the shape.
 *
 *   Five digits like the Spanish, French and German forms, but do NOT infer a province from the
 *   leading digits the way `es/codigo-postal.ts` documents for Spain. Italy's large cities are
 *   assigned RANGES rather than a single code (Rome spans 00118–00199, Milan 20121–20162), and
 *   several provinces share leading digits, so the CAP narrows geography without identifying a
 *   province. It is the same trap German PLZ Leitzonen set, in a different disguise.
 */

import type { Tagged } from "type-fest"

/**
 * An Italian postcode: five digits (`00184` is Rome, Rione Monti).
 *
 * @category Postal
 * @type string
 * @title CAP
 * @pattern ^\d{5}$
 */
export type CAP = Tagged<string, "CAP">

/**
 * Shape of an Italian CAP — five digits.
 */
export const CAP_PATTERN = /^\d{5}$/

/**
 * Normalize a CAP surface form to the bare five digits: trim surrounding whitespace (`" 00184 "` → `"00184"`). Returns
 * null when the result is not a five-digit code.
 */
export function normalizeCAP(raw: unknown): CAP | null {
	if (typeof raw !== "string") return null
	const s = raw.trim()

	return CAP_PATTERN.test(s) ? (s as CAP) : null
}

/**
 * Type-predicate for a (normalized) Italian CAP.
 */
export function isCAP(input: unknown): input is CAP {
	return typeof input === "string" && CAP_PATTERN.test(input)
}

/**
 * Narrow a string to a {@link CAP}, or `null` when it is not one.
 *
 * @deprecated Use {@link normalizeCAP}.
 */
export function parseCAP(input: string): CAP | null {
	return normalizeCAP(input)
}
