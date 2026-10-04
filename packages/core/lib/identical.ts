/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deep identity for JSON-shaped values, wrapping the runtime's `isDeepStrictEqual` so a record whose
 *   fields were reordered no longer reads as changed. Node-only: `node:util` has no browser build, and
 *   `objects.ts` stays on the browser client's static import path.
 */

import { isDeepStrictEqual } from "node:util"

/**
 * Predicate to check if two values are deeply identical.
 *
 * Not a type predicate: asserting one would narrow the arguments at call sites that keep both values.
 */
export function isIdentical<A, E>(actual: A, expected: E): boolean {
	return isDeepStrictEqual(actual, expected)
}
