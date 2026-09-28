/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines the UK postcode type. It also defines validation and normalization, plus the outward/inward split.
 *
 *   US ZIPs and German PLZs use five digits. French codes postaux do too. UK postcodes have a more complex shape.
 *   Those systems map a prefix to an administrative unit. UK postcodes require handling the shape itself:
 *
 *   - It is **variable-length alphanumeric**, from six characters (`M1 1AE`) to eight (`SW1A 1AA`),
 *       across forms like `B33 8TH`, `CR2 6XH`, `DN55 1PT`.
 *   - It splits into outward and inward codes. The **outward code** contains the area and district before the space,
 *       such as `SW1A`. The **inward code** contains the sector and unit in the final three characters, such as `1AA`.
 *       Royal Mail sorts the outward
 *       code to a delivery office. It then sorts the inward code to a walk.
 *   - It does **not align with administrative geography**. A postcode area is a Royal Mail routing construct derived
 *       from a sorting town such as south-west London (`SW`) or Edinburgh (`EH`). It does not identify a county or
 *       constituent country. A UK postcode does not identify a county as a French code postal identifies a département.
 *       `postcode-area.ts` maps postcodes to countries because they have no administrative hierarchy to inherit.
 *
 *   The hard work here is validating the shape and normalizing its internal space. It also separates outward from
 *   inward codes. The implementation does not use a prefix-to-administration lookup.
 */

import type { Tagged } from "type-fest"

/**
 * A UK postcode: variable-length alphanumeric, outward + inward (`SW1A 1AA`, `M1 1AE`).
 *
 * The canonical form carries exactly one space before the final three characters.
 * Unlike a US/DE/FR postcode, the shape is not a fixed-width numeric string —
 * see {@link UK_POSTCODE_PATTERN}.
 *
 * @category Postal
 * @type string
 * @title UK postcode
 * @pattern ^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$
 */
/**
 * Shortest valid UK postcode once spaces are stripped, e.g. `M11AE`.
 */
const MIN_POSTCODE_LENGTH = 5

export type Postcode = Tagged<string, "UkPostcode">

/**
 * UK postcode shape.
 *
 * A permissive form of the Royal Mail / UK-gov regex: one or two leading letters (the area),
 * a district digit, an optional district letter-or-digit, then the inward sector digit
 * and two unit letters, with the inward space optional so an un-spaced `SW1A1AA` still validates.
 * The full UK-gov pattern additionally whitelists the British Overseas Territory codes
 * (`ascn`, `sthl`, `bbnd`, …); those are rare enough to leave to the gazetteer.
 */
export const UK_POSTCODE_PATTERN = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i

/**
 * Normalize a UK postcode surface form.
 *
 * The function uppercases the text and strips surrounding whitespace.
 * It ensures exactly one space before the final three characters (the inward code).
 *
 * `sw1a1aa` → `SW1A 1AA`, `M11AE` → `M1 1AE`, `b33 8th` → `B33 8TH`.
 * Returns null if the result is not a valid postcode.
 */
export function normalizeUkPostcode(raw: unknown): Postcode | null {
	if (typeof raw !== "string") return null
	// Drop all whitespace, uppercase, then re-insert the single canonical space before the inward 3.
	const compact = raw.replaceAll(/\s+/g, "").toUpperCase()

	if (compact.length < MIN_POSTCODE_LENGTH) return null
	const spaced = `${compact.slice(0, -3)} ${compact.slice(-3)}`

	return UK_POSTCODE_PATTERN.test(spaced) ? (spaced as Postcode) : null
}

/**
 * Type-predicate for a UK postcode surface form (space optional).
 */
export function isUkPostcode(input: unknown): input is Postcode {
	return typeof input === "string" && UK_POSTCODE_PATTERN.test(input.trim())
}

/**
 * The outward code — the part before the space (area + district), e.g. `SW1A 1AA` → `SW1A`, `M1 1AE` → `M1`.
 *
 * Normalizes first so an un-spaced input still cleaves correctly.
 * Null if invalid.
 */
export function outwardCode(pc: unknown): string | null {
	const normalized = normalizeUkPostcode(pc)

	if (!normalized) return null

	return normalized.slice(0, normalized.indexOf(" "))
}

/**
 * The inward code — the three characters after the space (sector + unit),
 * e.g. `SW1A 1AA` → `1AA`, `M1 1AE` → `1AE`.
 *
 * Null if invalid.
 */
export function inwardCode(pc: unknown): string | null {
	const normalized = normalizeUkPostcode(pc)

	if (!normalized) return null

	return normalized.slice(normalized.indexOf(" ") + 1)
}

/**
 * The postcode area — the leading one or two letters of the outward code, the Royal Mail routing
 * region derived from a sorting town: `SW1A 1AA` → `SW`, `M1 1AE` → `M`, `B33 8TH` → `B`.
 *
 * This is the key into `postcode-area.ts`'s area→country map.
 * Null if the input is not a valid postcode.
 */
export function postcodeArea(pc: unknown): string | null {
	const outward = outwardCode(pc)

	if (!outward) return null
	const match = /^[A-Z]{1,2}/.exec(outward)

	return match ? match[0] : null
}
