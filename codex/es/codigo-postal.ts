/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Spanish postal codes (código postal): the branded type, the shape, and the province prior.
 *
 *   The contrast with a German PLZ is the informative part. A PLZ's leading digit maps to a Leitzone
 *   that deliberately CROSSES state borders, so it cannot tell you the Bundesland. A Spanish código
 *   postal is the opposite: its first TWO digits are the province code, assigned alphabetically
 *   (01 Álava … 28 Madrid … 50 Zaragoza), so the province is derivable from the postcode exactly.
 *   Code that wants a Spanish region from an address can read it off the postcode; code that wants a
 *   German one cannot.
 */

import type { Tagged } from "type-fest"

/**
 * A Spanish postal code: five digits, `PPNNN`, where `PP` is the province (`28001` is Madrid).
 *
 * @category Postal
 * @type string
 * @title CodigoPostal
 * @pattern ^\d{5}$
 */
export type CodigoPostal = Tagged<string, "CodigoPostal">

/**
 * Shape of a Spanish código postal — five digits. Identical in shape to a French code postal, a German PLZ and a US
 * ZIP; disambiguation is the parser's job, not the pattern's.
 */
export const CODIGO_POSTAL_PATTERN = /^\d{5}$/

/**
 * Narrow a string to a {@link CodigoPostal}, or `null` when it is not one.
 */
export function parseCodigoPostal(input: string): CodigoPostal | null {
	const s = input.trim()

	return CODIGO_POSTAL_PATTERN.test(s) ? (s as CodigoPostal) : null
}

/**
 * The two-digit province prefix (`"28001"` → `"28"`), or `null` for a non-postcode. Callers map it through their own
 * province table; this module deliberately does not ship one, since the campaign that needed it only needs the shape.
 */
export function codigoPostalProvincePrefix(input: string): string | null {
	const code = parseCodigoPostal(input)

	return code ? code.slice(0, 2) : null
}
