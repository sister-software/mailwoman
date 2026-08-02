/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Italian postal codes (Codice di Avviamento Postale, CAP): the branded type and the shape.
 *
 *   Five digits like the Spanish, French and German forms, but do NOT infer a province from the
 *   leading digits the way `es/codigo-postal.ts` documents for Spain. Italy's large cities are
 *   assigned RANGES rather than a single code (Rome spans 00118–00199, Milan 20121–20162), and
 *   several provinces share leading digits, so the CAP narrows geography without identifying a
 *   province. It is the same trap German PLZ Leitzonen set, in a different disguise.
 */

import type { Tagged } from "type-fest"

/**
 * An Italian postal code: five digits (`00184` is Rome, Rione Monti).
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
 * Narrow a string to a {@link CAP}, or `null` when it is not one.
 */
export function parseCAP(input: string): CAP | null {
	const s = input.trim()

	return CAP_PATTERN.test(s) ? (s as CAP) : null
}
