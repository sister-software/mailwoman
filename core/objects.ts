/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Utility functions for working with objects.
 */

import type { PathBuilderLike } from "path-ts"
import type { JsonObject } from "type-fest"

import { isIterable } from "./collections.ts"

type SetLike<T> = { has(value: T): boolean } | Iterable<T>

/**
 * Type-utility for extracting the string keys of an object.
 *
 * @internal
 */
export type StringKeyOf<O> = Extract<keyof O, string>

/**
 * @param input Source object.
 * @param scalarEnum Unconstrained scalar enum whose values present in `input` will be used as keys, such as an
 *   enum-like object.
 *
 * @returns A subset of the source object with only properties present in `scalarEnum`.
 */
export function pick<O extends object, K extends string>(
	input: O,
	scalarEnum: Record<K, K>,
	transform?: (value: O[keyof O], key: keyof O, input: O) => never
): Pick<O, StringKeyOf<O>>

/**
 * @param input Source object.
 * @param setLike Set-like object whose members represent the subset of keys to pick.
 *
 * @returns A subset of the source object with only properties present in `scalarEnum`.
 */
export function pick<O extends object, K extends keyof O>(
	input: O,
	setLike: SetLike<K>,
	transform?: (value: O[keyof O], key: keyof O, input: O) => never
): Pick<O, K>

/**
 * @param input Source object.
 * @param scalarEnum Enum-like object whose members represent the subset of keys to pick.
 *
 * @returns A subset of the source object with only properties present in `scalarEnum`.
 */
export function pick<O extends object, K extends keyof O>(
	input: O,
	scalarEnum: Record<K, K>,
	transform?: (value: O[keyof O], key: keyof O, input: O) => never
): Pick<O, StringKeyOf<O>>

/**
 * @param input Source object.
 * @param constraints Unconstrained iterable of keys to pick, such as in array or Map.
 *
 * @returns A subset of the source object with only properties present in `constraints`.
 */
export function pick<O extends object, K extends keyof O = StringKeyOf<O>>(
	input: O,
	constraints: Iterable<K>,
	transform?: (value: O[keyof O], key: keyof O, input: O) => never
): Pick<O, K>

/**
 * @param input Source object.
 * @param constraints Enum-like object whose members represent the subset of keys to pick.
 *
 * @returns A subset of the source object with only properties present in `constraints`.
 */
export function pick<O extends object, K extends keyof O = StringKeyOf<O>>(
	input: O,
	constraints: Record<K, K>,
	transform?: (value: O[keyof O], key: keyof O, input: O) => never
): Pick<O, K>

/**
 * @param input Source object.
 * @param keys Unconstrained iterable of keys to pick, such as in array or Map.
 *
 * @returns A subset of the source object with only properties present in `keys`.
 */
export function pick<O extends object, K extends string>(
	input: O,
	keys: Iterable<K>,
	transform?: (value: O[keyof O], key: keyof O, input: O) => never
): Pick<O, StringKeyOf<O>>

/**
 * @param input Source object.
 * @param constraints Unconstrained iterable of keys to pick, such as in array or Map.
 *
 * @returns A subset of the source object with only properties present in `constraints`.
 */
export function pick<O extends object, K extends keyof O = StringKeyOf<O>>(
	input: O,
	constraints: Iterable<K> | Record<K, K> | SetLike<K>,
	transform?: (value: O[keyof O], key: keyof O, input: O) => never
): Pick<O, K> {
	const picked: Partial<Pick<O, keyof O>> = {}

	if (!input) return picked as Pick<O, K>

	if (!constraints) return input as Pick<O, K>

	const keys = isIterable(constraints) ? Array.from(constraints) : Object.values(constraints)

	for (const key of keys) {
		const value = (input as never)[key]
		picked[key as keyof O] = transform ? transform(value, key, input) : value
	}

	return picked as Pick<O, K>
}

/**
 * Type-predicate for checking if a value appears to be a record, i.e. an object that is not an array.
 *
 * @category Type Guard
 * @category Object
 */

export function isRecordLike(input: unknown): input is object {
	return typeof input === "object" && input !== null && !Array.isArray(input)
}

/**
 * Type-helper to remove nullability from an object's properties.
 *
 * @category Object
 */
export type NonNullableObject<T> = { [P in keyof T]-?: NonNullable<T[P]> } & NonNullable<T>

/**
 * Given an object, returns a new object with all nullable properties removed.
 *
 * This is useful for cleaning up objects before serializing them to JSON.
 *
 * @category Object
 */
export function omitNullable<T extends object>(input: T): NonNullableObject<T> {
	const result: Record<string, unknown> = {}

	for (const [key, currentValue] of Object.entries(input)) {
		if (isRecordLike(currentValue)) {
			const childResult = omitNullable(currentValue)

			if (Object.keys(childResult).length) {
				result[key] = childResult
			}
		} else if (Array.isArray(currentValue)) {
			const arr = currentValue
				.map((entryValue) => (isRecordLike(entryValue) ? omitNullable(entryValue) : entryValue))
				.filter((val) => val != null)

			if (arr.length) {
				result[key] = arr
			}
		} else if (currentValue !== null) {
			result[key] = currentValue
		}
	}

	return result as NonNullableObject<T>
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

export type FlattenObjectKeys<T extends JsonObject, Key = keyof T> = Key extends string
	? T[Key] extends JsonObject
		? `${Key}.${FlattenObjectKeys<T[Key]>}`
		: `${Key}`
	: never

/**
 * Flattens an object into a single-level object with dot-separated keys.
 */
export function flattenObject<T extends JsonObject>(
	obj: T,
	prefix: string[] = [],
	current: Record<string, unknown> = {}
): Record<FlattenObjectKeys<T>, unknown> {
	prefix = prefix || []
	current = current || {}

	// Remember kids, null is also an object!
	if (typeof obj === "object" && obj !== null) {
		Object.keys(obj).forEach((key) => {
			;(flattenObject as typeof flattenObject)(obj[key] as JsonObject, prefix.concat(key), current)
		})
	} else {
		current[prefix.join(".")] = obj
	}

	return current
}
