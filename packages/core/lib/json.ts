/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   JSON parsing and printing: the strict parser every reader of untrusted text goes through, its forgiving sibling, the
 *   array reader for a JSON column, and the pretty printer. Platform-neutral by construction — a type import and the
 *   global `JSON` are all it reaches — so the license key module, which a Cloudflare Worker bundles, can depend on it.
 */

import type { PathBuilderLike } from "path-ts"
import type { Tagged } from "type-fest"

/**
 * A branded type representing a string that is known to be valid JSON.
 */
export type StringifiedJSON = Tagged<"StringifiedJSON", string>

/**
 * Pretty-print an object as JSON with tabs for indentation.
 *
 * This is effectively a wrapper around `JSON.stringify` that returns a branded type to indicate that the output is
 * valid JSON. It also allows for optional newline and indentation settings.
 *
 * @param input The object to be pretty-printed.
 * @param newline Whether to append a newline character at the end of the output. Defaults to `true`.
 * @param space The indent: a string to repeat, or a count of spaces. Defaults to a tab character (`"\t"`). Both forms
 *   are accepted because both are what the builtin accepts, and a caller converting `2` to `" "` at the call site would
 *   be doing the conversion this parameter exists to hold.
 *
 * @returns A string containing the pretty-printed JSON representation of the input object.
 * @see {@linkcode stringifyJSON} for a jsonl-compatible version that returns a branded type.
 */
export function prettyJSON(input: unknown, newline = true, space: string | number = "\t"): StringifiedJSON {
	return (JSON.stringify(input, null, space) + (newline ? "\n" : "")) as StringifiedJSON
}

/**
 * Stringify an object as JSON.
 *
 * This is effectively a wrapper around `JSON.stringify` that returns a branded type to indicate that the output is
 * valid JSON. It is also one of two places in the codebase that is allowed to use `JSON.stringify`
 *
 * @param input The object to be stringified.
 * @param keys An allowlist of property names, in the order they should print. Two call sites need it and neither is
 *   cosmetic: a cache key that must omit the API key and fix the order of what remains, and a regenerated seed file
 *   that must diff only where a value changed. Passing the list here keeps both on the branded printer.
 *
 * @returns A string containing the JSON representation of the input object.
 * @see {@linkcode prettyJSON} for human-friendly JSON output.
 */
export function stringifyJSON<T>(input: T, keys?: readonly string[]): StringifiedJSON {
	return JSON.stringify(input, keys as string[] | undefined) as StringifiedJSON
}

/**
 * Given serialized JSON, attempt to parse it.
 *
 * Non-throwing: invalid JSON — and any non-string input, `Buffer` included — returns the fallback (`null` unless one is
 * given). Callers that need a throw on corrupt input, or `JSON.parse`'s reviver parameter, use `JSON.parse` directly
 * behind a scoped lint disable.
 */
export function tryParsingJSON<T = unknown>(input: unknown): T | null
export function tryParsingJSON<T = unknown, F = T>(input: unknown, fallback: F): T | F

export function tryParsingJSON<T = unknown, F = T>(input: unknown, fallback?: F): T | F | null {
	if (typeof input !== "string") return fallback ?? null

	try {
		// oxlint-disable-next-line no-restricted-properties -- The wrapper the rule recommends.
		return JSON.parse(input) as T
	} catch {
		return fallback ?? null
	}
}

export class JSONParseError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "JSONParseError"
	}
}

/**
 * Parses JSON input or throws a `JSONParseError` if parsing fails.
 *
 * @param input - The JSON input to parse.
 *
 * @returns The parsed object.
 */
export function parseJSONStrict<T = unknown>(input: PathBuilderLike): T {
	if (!input) {
		throw new JSONParseError(`Expected JSON input, got ${input}`)
	}

	try {
		// oxlint-disable-next-line no-restricted-properties -- The wrapper the rule recommends.
		return JSON.parse(String(input)) as T
	} catch (error: unknown) {
		throw new JSONParseError(`Failed to parse JSON`, { cause: error })
	}
}

/**
 * A JSON array carried inside a string field. `undefined` answers `[]`; a value that parses to anything but an array
 * throws, because a non-array there is a schema change at the source rather than something to coerce — an empty array
 * would read as "none", which is not what a differently-shaped value means.
 *
 * @param scope Names the reader in the error, e.g. `coastal client`.
 */
export function parseJSONArray<T>(raw: string | undefined, scope: string): T[] {
	if (raw === undefined) return []

	const parsed = parseJSONStrict<unknown>(raw)

	if (!Array.isArray(parsed)) {
		throw new TypeError(`${scope}: expected a JSON array, got ${typeof parsed}`)
	}

	return parsed as T[]
}
