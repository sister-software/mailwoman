/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Canadian postal codes: the branded type, the shape, normalization, and the FSA-letter →
 *   province/territory prior — the only ALPHANUMERIC postcode of the systems the codex models.
 *
 *   The informative contrast across `us/zipcode.ts`, `de/postleitzahl.ts`, `fr/code-postal.ts`, and
 *   here:
 *
 *   - A US ZIP is numeric; its first digit maps to a loose BAND of states.
 *   - A German PLZ is numeric; its first digit maps to a Leitzone that CROSSES Bundesland borders.
 *   - A French code postal is numeric; its first TWO digits ARE the département.
 *   - A Canadian postal code is `A1A 1A1` — Letter Digit Letter, then Digit Letter Digit — and its
 *       first LETTER pins the province or territory directly (`M` → Ontario, `H` → Quebec, `V` →
 *       British Columbia). So like the French prefix it is a clean admin prior, but it does the job
 *       with a single ALPHA character rather than digits.
 *
 *   The clean rule has two wrinkles worth knowing. `X` is SHARED by the Northwest Territories and
 *   Nunavut (no single letter splits them), so `provinceOfPostalCode` returns an array there. And
 *   the large provinces span SEVERAL letters: Ontario alone owns `K L M N P`, Quebec owns `G H J`.
 *   The first three characters form the FSA (Forward Sortation Area); the last three are the LDU
 *   (Local Delivery Unit). A FSA whose SECOND character (the first digit) is `0` is a RURAL area —
 *   the bridge to the wider, lower-density delivery zones.
 */

import type { Tagged } from "type-fest"

import type { CanadianProvinceCode } from "./province.js"

/**
 * A Canadian postal code: `A1A 1A1`. Six alphanumeric characters in a strict Letter-Digit-Letter-Digit-Letter-Digit
 * pattern, conventionally written with a single space after the third. Unlike the other systems' bare five digits, the
 * shape alone already says "Canada".
 *
 * @category Postal
 * @type string
 * @title Postal Code
 * @pattern ^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$
 */
export type PostalCode = Tagged<string, "CaPostalCode">

/**
 * The Canadian postal-code shape. The valid FIRST letters exclude `D F I O Q U W Z` (never used to open a postcode);
 * the interior letters additionally exclude `D F I O Q U` (the visually ambiguous ones). The space between FSA and LDU
 * is optional in the raw form.
 */
export const CA_POSTAL_CODE_PATTERN = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i

/**
 * Normalize a postal-code surface form to canonical `A1A 1A1`: uppercase and ensure exactly one space between the FSA
 * (first three chars) and the LDU (last three) — `K1A0B1` → `K1A 0B1`, `k1a 0b1` → `K1A 0B1`. Returns null if the input
 * is not a valid Canadian postal code.
 */
export function normalizeCaPostalCode(raw: unknown): PostalCode | null {
	if (typeof raw !== "string") return null
	const compact = raw.trim().toUpperCase().replace(/\s+/g, "")

	if (compact.length !== 6) return null
	const spaced = `${compact.slice(0, 3)} ${compact.slice(3)}`

	return CA_POSTAL_CODE_PATTERN.test(spaced) ? (spaced as PostalCode) : null
}

/** Type-predicate for a Canadian postal code (accepts the spaced or unspaced surface form). */
export function isCaPostalCode(input: unknown): input is PostalCode {
	return typeof input === "string" && CA_POSTAL_CODE_PATTERN.test(input)
}

/**
 * FSA first letter → province/territory. Clean (one province per letter) except `X`, shared by the Northwest
 * Territories and Nunavut, and the large provinces that span several letters: Ontario owns `K L M N P` and Quebec owns
 * `G H J`. Letters `D F I O Q U W Z` never open a Canadian postcode and so do not appear here.
 */
export const FSA_LETTER_TO_PROVINCE: Record<string, CanadianProvinceCode | CanadianProvinceCode[]> = {
	A: "NL",
	B: "NS",
	C: "PE",
	E: "NB",
	G: "QC",
	H: "QC",
	J: "QC",
	K: "ON",
	L: "ON",
	M: "ON",
	N: "ON",
	P: "ON",
	R: "MB",
	S: "SK",
	T: "AB",
	V: "BC",
	X: ["NT", "NU"],
	Y: "YT",
}

/**
 * The province/territory a postal code belongs to, via its FSA first letter. Returns the single code for the clean
 * letters, the `["NT", "NU"]` pair for the shared `X`, and null if the input is not a valid Canadian postal code (or
 * its first letter has no province, which the pattern already forbids).
 */
export function provinceOfPostalCode(postalCode: unknown): CanadianProvinceCode | CanadianProvinceCode[] | null {
	const normalized = normalizeCaPostalCode(postalCode)

	if (!normalized) return null

	return FSA_LETTER_TO_PROVINCE[normalized[0]!] ?? null
}

/**
 * True when a postal code is RURAL: its SECOND character (the FSA's first digit) is `0`. Canada Post uses a `0` in that
 * position to mark the lower-density delivery zones (rural routes, small communities) — the contrast with the urban
 * `1`–`9` FSAs. Returns false for a non-code.
 */
export function isRuralPostalCode(pc: unknown): boolean {
	const normalized = normalizeCaPostalCode(pc)

	if (!normalized) return false

	return normalized[1] === "0"
}
