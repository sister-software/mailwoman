/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The backend's name key for fake gazetteers, modelling `normalizeLocalityForKey` rather than
 *   importing it because `@mailwoman/resolver` is backend-agnostic by design.
 */

/**
 * Fold diacritics away (`Zürich` → `zurich`) the way `normalizeLocalityForKey` does, deleting the
 * combining mark rather than replacing it with a space.
 */
export function backendNameKey(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/\p{M}/gu, "")
		.replaceAll(/[^a-z0-9 ]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()
}
