/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The single-space display form the source readers normalize into, and the compact key form.
 */

/**
 * Normalize a raw postcode value to the single-space display form: whitespace runs
 * (non-breaking spaces included) collapsed to one space, ends trimmed, upper-cased.
 *
 * `BT3 9QQ` and `bt3 9qq` are the same postcode and would otherwise validate as one code and one typo.
 */
export function normalizePostcodeDisplay(raw: string): string {
	return raw.replaceAll(/\s+/gu, " ").trim().toUpperCase()
}

/**
 * The compact key form of a postcode: every whitespace character removed, upper-cased.
 *
 * `RG40 4HR`, `rg40 4hr` and `RG40  4HR` all compact to `RG404HR`, Code-Point Open's `spr.name` form.
 */
export function compactPostcode(raw: string): string {
	return raw.replaceAll(/\s+/gu, "").toUpperCase()
}
