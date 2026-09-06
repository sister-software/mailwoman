/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Utility functions for working with the runtime environment.
 */

import { z } from "zod"

/**
 * Wrap a coerced schema so a BLANK value means the same as an absent one.
 *
 * A shell `export FOO=`, an unset Docker/CI `${VAR}` interpolation and a compose file with a missing key all arrive as
 * an empty string rather than as nothing. `z.coerce.number()` turns that into `0`, which any `.positive()` or `.min()`
 * then rejects — so the process dies at import instead of falling back to its default, and the message points at a
 * variable the operator believes they never set.
 *
 * The `.optional()`/`.default()` must be applied to `inner` BEFORE it reaches here: the outer value is present, so an
 * outer `.optional()` never fires — `inner` is what receives the `undefined` this produces.
 */
export function blankAsAbsent<T extends z.ZodType>(inner: T) {
	return z.preprocess((v) => (v === "" ? undefined : v), inner)
}
