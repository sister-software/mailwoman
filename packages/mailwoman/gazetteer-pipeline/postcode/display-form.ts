/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The single-space, upper-case postcode display form the source readers normalize into.
 */

/**
 * Normalize a raw postcode value to the single-space display form: whitespace runs (non-breaking spaces included)
 * collapsed to one space, ends trimmed, upper-cased. `BT3 9QQ` and `bt3 9qq` are the same postcode and would otherwise
 * validate as one code and one typo.
 */
export function normalizePostcodeDisplay(raw: string): string {
	return raw.replaceAll(/\s+/gu, " ").trim().toUpperCase()
}
