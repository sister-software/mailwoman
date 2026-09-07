/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one read every name register offers a decode-time repair: given the surface a model closed a span on and the
 *   text that follows, the characters that would extend the surface to a register name. A surface that already IS a
 *   name and is not the prefix of a longer one answers null.
 */

/**
 * The remainder of the first register name that begins with `surface` and continues into `following`, or null.
 */
export function completeFromRegister(names: readonly string[], surface: string, following: string): string | null {
	for (const name of names) {
		if (name.length > surface.length && name.startsWith(surface)) {
			const remainder = name.slice(surface.length)

			if (following.startsWith(remainder)) return remainder
		}
	}

	return null
}
