/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lengths and offsets in code points, the unit the corpus records' span offsets use.
 */

/**
 * The number of code points in `text`, which `text.length` overstates by one per
 * character outside the Basic Multilingual Plane.
 */
export function codePointLength(text: string): number {
	let length = 0

	for (const _ of text) {
		length++
	}

	return length
}
