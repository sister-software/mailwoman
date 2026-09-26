/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Utility functions for working with the runtime environment.
 */

import { z } from "zod"

/**
 * Wrap a coerced schema so a blank value means the same as an absent one: a shell `export FOO=`,
 * an unset Docker/CI `${VAR}` interpolation and a missing compose key all arrive as an empty string,
 * which `z.coerce.number()` turns into `0` and any `.positive()` or `.min()` then rejects.
 *
 * The `.optional()`/`.default()` must be applied to `inner` before it reaches here,
 * because the outer value is present and an outer `.optional()` never fires.
 */
export function blankAsAbsent<T extends z.ZodType>(inner: T) {
	return z.preprocess((v) => (v === "" ? undefined : v), inner)
}
