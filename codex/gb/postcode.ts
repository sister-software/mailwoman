/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   UK postcodes: the branded type, the validation shape, normalization, and the outward/inward
 *   split.
 *
 *   This is the MOST COMPLEX postcode of any system in the codex, and the contrast is the whole point
 *   of the file. A US ZIP, a German PLZ, and a French code postal are all a fixed five digits — the
 *   shape is trivial and the only interesting question is what admin unit the prefix maps to. The
 *   UK postcode is none of that:
 *
 *   - It is **variable-length alphanumeric**, from six characters (`M1 1AE`) to eight (`SW1A 1AA`),
 *       across forms like `B33 8TH`, `CR2 6XH`, `DN55 1PT`.
 *   - It splits into an **OUTWARD code** (area + district, the part before the space — `SW1A`) and an
 *       **INWARD code** (sector + unit, the three chars after — `1AA`). Royal Mail sorts on the
 *       outward to a delivery office, then on the inward to a walk.
 *   - And — the lesson that propagates to `postcode-area.ts` — it does **NOT align with administrative
 *       geography**. A postcode area is a Royal Mail routing construct named after a sorting town
 *       (`SW` = south-west London, `EH` = Edinburgh), NOT a county or a constituent country. You
 *       cannot read a county off a UK postcode the way you read a département off a French one; the
 *       postcode→country mapping in `postcode-area.ts` exists precisely _because_ there is no clean
 *       hierarchy to inherit.
 *
 *   So unlike the other systems, the hard work here is the shape itself — validating, normalizing the
 *   internal space, and cleaving outward from inward — not a prefix→admin lookup.
 */

import type { Tagged } from "type-fest"

/**
 * A UK postcode: variable-length alphanumeric, outward + inward (`SW1A 1AA`, `M1 1AE`). The canonical form carries
 * exactly one space before the final three characters. Unlike a US/DE/FR postcode, the shape is not a fixed-width
 * numeric string — see {@link UK_POSTCODE_PATTERN}.
 *
 * @category Postal
 * @type string
 * @title UK postcode
 * @pattern ^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$
 */
/** Shortest valid UK postcode once spaces are stripped, e.g. `M11AE`. */
const MIN_POSTCODE_LENGTH = 5

export type Postcode = Tagged<string, "UkPostcode">

/**
 * UK postcode shape. A permissive form of the Royal Mail / UK-gov regex: one or two leading letters (the area), a
 * district digit, an optional district letter-or-digit, then the inward sector digit and two unit letters, with the
 * inward space optional so an un-spaced `SW1A1AA` still validates. The full UK-gov pattern additionally whitelists the
 * British Overseas Territory codes (`ASCN`, `STHL`, `BBND`, …); those are rare enough to leave to the gazetteer.
 */
export const UK_POSTCODE_PATTERN = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i

/**
 * Normalize a UK postcode surface form: uppercase, strip surrounding whitespace, and ensure exactly one space before
 * the final three characters (the inward code). `sw1a1aa` → `SW1A 1AA`, `M11AE` → `M1 1AE`, `b33 8th` → `B33 8TH`.
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

/** Type-predicate for a UK postcode surface form (space optional). */
export function isUkPostcode(input: unknown): input is Postcode {
	return typeof input === "string" && UK_POSTCODE_PATTERN.test(input.trim())
}

/**
 * The OUTWARD code — the part before the space (area + district), e.g. `SW1A 1AA` → `SW1A`, `M1 1AE` → `M1`. Normalizes
 * first so an un-spaced input still cleaves correctly; null if invalid.
 */
export function outwardCode(pc: unknown): string | null {
	const normalized = normalizeUkPostcode(pc)

	if (!normalized) return null

	return normalized.slice(0, normalized.indexOf(" "))
}

/**
 * The INWARD code — the three characters after the space (sector + unit), e.g. `SW1A 1AA` → `1AA`, `M1 1AE` → `1AE`.
 * Null if invalid.
 */
export function inwardCode(pc: unknown): string | null {
	const normalized = normalizeUkPostcode(pc)

	if (!normalized) return null

	return normalized.slice(normalized.indexOf(" ") + 1)
}

/**
 * The POSTCODE AREA — the leading one or two LETTERS of the outward code, the Royal Mail routing region named after a
 * sorting town: `SW1A 1AA` → `SW`, `M1 1AE` → `M`, `B33 8TH` → `B`. This is the key into `postcode-area.ts`'s
 * area→country map. Null if the input is not a valid postcode.
 */
export function postcodeArea(pc: unknown): string | null {
	const outward = outwardCode(pc)

	if (!outward) return null
	const match = /^[A-Z]{1,2}/.exec(outward)

	return match ? match[0] : null
}
