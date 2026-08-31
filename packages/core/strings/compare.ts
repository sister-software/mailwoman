/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file String comparators.
 */

/**
 * A locale-independent string order for `Array.prototype.sort`.
 *
 * `localeCompare` answers differently under different ICU builds, so an artifact sorted with it is not reproducible
 * across machines; code-point order is.
 */
export function compareByCodePoint(left: string, right: string): number {
	if (left < right) return -1

	if (left > right) return 1

	return 0
}
