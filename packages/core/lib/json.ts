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

/**
 * Pretty-print an object as JSON with tabs for indentation.
 */
export function prettyJSON(input: unknown, newline = true, space = "\t"): string {
	return JSON.stringify(input, null, space) + (newline ? "\n" : "")
}
