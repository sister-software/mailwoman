/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `no-restricted-properties` entries, named so an override can lift ONE of them.
 *
 *   oxlint models the rule as a single list, so an override that writes `"off"` drops every entry —
 *   including the ones it never meant to touch, and including whatever is added to the list later. Each
 *   entry is a named constant here and {@linkcode restrictedPropertiesExcept} rebuilds the list by
 *   subtraction, so an override names what it is lifting and inherits everything it is not.
 */

/**
 * One `no-restricted-properties` entry, as oxlint reads it.
 */
export interface RestrictedProperty {
	object: string
	property: string
	message: string
}

/**
 * `JSON.parse` throws on corrupt input and returns `any`, so every direct call site either wraps it in its own
 * try/catch or lets the exception escape untyped.
 */
export const JSON_PARSE: RestrictedProperty = {
	object: "JSON",
	property: "parse",
	message:
		'Prefer `tryParsingJSON` from "@mailwoman/core/objects" — typed, non-throwing, explicit fallback. ' +
		"If a throw on corrupt input is the contract here, import and use `parseJSONStrict` instead.",
}

/**
 * `JSON.stringify` returns a bare `string`, so a caller cannot tell a serialized payload from any other text, and the
 * two call shapes get re-typed at every site that needs one.
 */
export const JSON_STRINGIFY: RestrictedProperty = {
	object: "JSON",
	property: "stringify",
	message:
		'Prefer `stringifyJSON` from "@mailwoman/core/json" for a compact line, or `prettyJSON` for the ' +
		"tab-indented form with a trailing newline. Both return the branded `StringifiedJSON`, and " +
		"`stringifyJSON` takes the key allowlist a replacer would have expressed.",
}

/**
 * Every entry, in the order a reader meets them. Private: the list is reached through
 * {@linkcode restrictedPropertiesExcept}, so no caller can pass a partial one by hand.
 */
const RESTRICTED_PROPERTIES: readonly RestrictedProperty[] = [JSON_PARSE, JSON_STRINGIFY]

/**
 * The rule with `lifted` removed — the form an override uses.
 *
 * Subtraction rather than a hand-written list: an override written as "these two still apply" silently stops applying
 * the third the day one is added, and the file it governs is the last place anyone looks.
 */
export function restrictedPropertiesExcept(...lifted: readonly RestrictedProperty[]) {
	return ["error", ...RESTRICTED_PROPERTIES.filter((entry) => !lifted.includes(entry))] as const
}
