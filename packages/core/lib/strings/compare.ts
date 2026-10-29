/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file String comparators.
 */

/**
 * A locale-independent string order for `Array.prototype.sort`.
 *
 * `localeCompare` answers differently under different ICU builds, so an artifact
 * sorted with it is not reproducible across machines.
 * This order is reproducible.
 *
 * It compares UTF-16 code units, which agrees with code-point order except where a character
 * outside the Basic Multilingual Plane meets one from U+E000 to U+FFFF: `"𨦻" < "＆"` here,
 * and U+FF06 sorts first by code point. {@linkcode compareByScalarValue} is the code-point order.
 */
export function compareByCodePoint(left: string, right: string): number {
	if (left < right) return -1

	if (left > right) return 1

	return 0
}

/**
 * Code-point order, the order Python's `sorted` gives a list of `str`.
 *
 * Use it where an artifact must sort as a Python builder sorted it.
 */
export function compareByScalarValue(left: string, right: string): number {
	const a = left[Symbol.iterator]()
	const b = right[Symbol.iterator]()

	for (;;) {
		const x = a.next()
		const y = b.next()

		if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1

		const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!

		if (difference) return difference
	}
}
