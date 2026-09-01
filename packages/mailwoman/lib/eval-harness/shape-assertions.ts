/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Compile-time shape bridges the corpus schemas assert themselves with.
 */

/**
 * Both directions of `extends`, as a `true`/`never` flag.
 */
export type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/**
 * `true` only when A and B have the SAME KEYS and the same value types.
 *
 * Assignability alone is not enough, and the difference is exactly the drift a corpus schema suffers: an OPTIONAL field
 * added to one side and not the other keeps both sides mutually assignable (a value missing an optional key is still
 * assignable), so a pure {@link MutuallyAssignable} bridge compiles clean through the very change it exists to catch.
 * Measured 2026-08-05 by adding `driftProbe?: string` to `SeedCase` — `tsc -b` passed. The key-set legs below are what
 * fails it.
 */
export type SameShape<A, B> = [keyof A] extends [keyof B]
	? [keyof B] extends [keyof A]
		? MutuallyAssignable<A, B>
		: never
	: never
