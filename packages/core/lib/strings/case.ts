/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { camelCase, capitalCase, snakeCase } from "change-case"
import type { CamelCase, SnakeCase } from "type-fest"

/**
 * Any character that is not a letter, a digit, or an underscore, in ANY script.
 *
 * `\W` cannot serve: it is `[^A-Za-z0-9_]` in JavaScript with or without the `u` flag, so every character of a
 * non-Latin name is "non-word" and the name is replaced rather than kept.
 */
const NON_KEY_CHARACTER = /[^\p{L}\p{N}_]+/gu

/**
 * Converts a name to snake_case, unless the name is already in all caps.
 *
 * A caseless script takes the all-caps branch, because `toUpperCase()` is the identity on Korean, Japanese, Chinese,
 * Hebrew and Arabic. That is the right branch — those names have no case to convert and survive as written.
 */
export function smartSnakeCase<T extends string>(name: T): T extends Uppercase<T> ? T : SnakeCase<T> {
	const normalizedName = name
		// Remove periods after capital letters, e.g. "U.S.A." -> "USA"
		.replaceAll(/([A-Z])(\.+)/g, "$1")
		.trim()

	if (normalizedName.toUpperCase() === normalizedName) {
		return (
			normalizedName
				// Replace everything that cannot be part of a key with underscores...
				.replaceAll(NON_KEY_CHARACTER, "_")
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
 * uniformly cased and is NOT `isupper()`. Ports that condition on a titlecase on the Python predicate need this one.
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

/**
 * Sentence-case a snake_case code into a display label: `afghan_restaurant` → `Afghan restaurant`.
 */
export function sentenceCaseSnake(code: string): string {
	const spaced = code.replaceAll("_", " ")

	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
