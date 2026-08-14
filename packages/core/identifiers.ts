/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { camelCase, capitalCase, snakeCase } from "change-case"
import type { CamelCase, SnakeCase } from "type-fest"

/**
 * Converts a name to snake_case, unless the name is already in all caps.
 */
export function smartSnakeCase<T extends string>(name: T): T extends Uppercase<T> ? T : SnakeCase<T> {
	const normalizedName = name
		// Remove periods after capital letters, e.g. "U.S.A." -> "USA"
		.replaceAll(/([A-Z])(\.+)/g, "$1")
		.trim()

	if (normalizedName.toUpperCase() === normalizedName) {
		return (
			normalizedName
				// Replace all non-word characters with underscores...
				.replaceAll(/\W{1,}/g, "_")
				// ...and then replace all sequences of underscores with a single underscore.
				.replaceAll(/_{2,}/g, "_") as T extends Uppercase<T> ? T : SnakeCase<T>
		)
	}

	return snakeCase(normalizedName) as T extends Uppercase<T> ? T : SnakeCase<T>
}

/**
 * Converts a name to camelCase, unless the name is already in all caps.
 */
export function smartCamelCase<T extends string>(name: T): T extends Uppercase<T> ? T : CamelCase<T> {
	if (name.toUpperCase() === name) {
		return name as T extends Uppercase<T> ? T : CamelCase<T>
	}

	return camelCase(name) as T extends Uppercase<T> ? T : CamelCase<T>
}

/**
 * Predicate to determine if a given string is uniformly cased, i.e. all uppercase or all lowercase.
 */
export function isUniformlyCased(input: string | null): boolean {
	return Boolean(input && (input === input.toUpperCase() || input === input.toLowerCase()))
}

/**
 * Capitalizes a string, unless the string is uniformly cased, or an email address.
 */
export function smartCapitalCase(input: string): string {
	if (input.includes("@")) return input

	if (isUniformlyCased(input)) return input

	return capitalCase(input)
}

/**
 * Python `str.isupper()`: at least one cased character, and every cased character uppercase.
 *
 * Distinct from {@link isUniformlyCased}, which reports `true` for a string with no cased characters at all — `"123"` is
 * uniformly cased and is NOT `isupper()`. Ports that gate a titlecase on the Python predicate need this one.
 */
export function pyIsUpper(input: string): boolean {
	let hasCased = false

	for (const ch of input) {
		if (ch.toLowerCase() === ch.toUpperCase()) continue

		hasCased = true

		if (ch !== ch.toUpperCase()) return false
	}

	return hasCased
}

/**
 * Python `str.title()`: titlecase the first cased character of each run, lowercase the rest.
 *
 * Not `capitalCase` from change-case, which splits on word boundaries and drops punctuation — Python titlecases
 * `"o'brien"` to `"O'Brien"` because the apostrophe ends a cased run.
 */
export function pyTitle(input: string): string {
	let out = ""
	let prevCased = false

	for (const ch of input) {
		const cased = ch.toLowerCase() !== ch.toUpperCase()

		out += prevCased ? ch.toLowerCase() : ch.toUpperCase()
		prevCased = cased
	}

	return out
}

/**
 * Titlecase a SHOUTED string, leave anything else alone — the shape source dumps use when a field arrives ALL CAPS.
 */
export function titlecaseIfUpper(input: string): string {
	return pyIsUpper(input) ? pyTitle(input) : input
}
