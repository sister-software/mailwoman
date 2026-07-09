/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { flattenObject, isRecordLike, omitNullable, pick, tryParsingJSON } from "./objects.ts"

test("pick: selects the listed keys from an array of keys", () => {
	expect(pick({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 })
})

test("pick: accepts a set-like constraint", () => {
	expect(pick({ a: 1, b: 2, c: 3 }, new Set(["b"] as const))).toEqual({ b: 2 })
})

test("pick: accepts an enum-like record (picks by its values)", () => {
	expect(pick({ a: 1, b: 2, c: 3 }, { a: "a", b: "b" })).toEqual({ a: 1, b: 2 })
})

test("pick: applies the transform callback to each picked value", () => {
	expect(pick({ a: 1, b: 2 }, ["a", "b"], (value) => ((value as number) * 10) as never)).toEqual({ a: 10, b: 20 })
})

test("pick: a falsy input returns an empty object", () => {
	expect(pick(null as never, ["a"])).toEqual({})
})

test("pick: a key absent from the source yields an undefined value", () => {
	const result = pick({ a: 1 } as Record<string, number>, ["z"])

	expect(result.z).toBeUndefined()
})

test("isRecordLike: true for plain objects", () => {
	expect(isRecordLike({})).toBe(true)
	expect(isRecordLike({ a: 1 })).toBe(true)
})

test("isRecordLike: false for arrays, null, and primitives", () => {
	expect(isRecordLike([])).toBe(false)
	expect(isRecordLike(null)).toBe(false)
	expect(isRecordLike(5)).toBe(false)
	expect(isRecordLike("str")).toBe(false)
	expect(isRecordLike(undefined)).toBe(false)
})

test("omitNullable: drops null and undefined but keeps falsy 0 and empty string", () => {
	expect(omitNullable({ a: 1, b: null, c: undefined, d: 0, e: "" })).toEqual({ a: 1, d: 0, e: "" })
})

test("omitNullable: recurses into nested objects", () => {
	expect(omitNullable({ a: { b: null, c: 2 } })).toEqual({ a: { c: 2 } })
})

test("omitNullable: a nested object that becomes empty is itself dropped", () => {
	expect(omitNullable({ a: { b: null }, c: 3 })).toEqual({ c: 3 })
})

test("omitNullable: filters nullable entries out of arrays", () => {
	expect(omitNullable({ a: [1, null, 2, undefined] })).toEqual({ a: [1, 2] })
})

test("omitNullable: an array that becomes empty is dropped", () => {
	expect(omitNullable({ a: [null, undefined], b: 7 })).toEqual({ b: 7 })
})

test("omitNullable: cleans record entries inside arrays", () => {
	expect(omitNullable({ a: [{ x: 1, y: null }] })).toEqual({ a: [{ x: 1 }] })
})

test("tryParsingJSON: parses valid JSON", () => {
	expect(tryParsingJSON('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] })
	expect(tryParsingJSON("42")).toBe(42)
	expect(tryParsingJSON('"hello"')).toBe("hello")
})

test("tryParsingJSON: invalid JSON falls back to null by default", () => {
	expect(tryParsingJSON("not json")).toBeNull()
})

test("tryParsingJSON: a non-string input falls back to null by default", () => {
	expect(tryParsingJSON(42)).toBeNull()
	expect(tryParsingJSON(null)).toBeNull()
	expect(tryParsingJSON(undefined)).toBeNull()
})

test("tryParsingJSON: an explicit fallback is returned for invalid or non-string input", () => {
	expect(tryParsingJSON("not json", "fallback" as never)).toBe("fallback")
	expect(tryParsingJSON(42, "fallback" as never)).toBe("fallback")
})

test("flattenObject: flattens nested keys to dot-separated paths", () => {
	expect(flattenObject({ a: { b: 1, c: { d: 2 } }, e: 3 })).toEqual({
		"a.b": 1,
		"a.c.d": 2,
		e: 3,
	})
})

test("flattenObject: a flat object is returned with single-segment keys", () => {
	expect(flattenObject({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
})

test("flattenObject: a null leaf is preserved at its dotted path", () => {
	// "null is also an object" — but a null *value* recurses to the else branch and is kept as a leaf.
	expect(flattenObject({ a: { b: null } } as never)).toEqual({ "a.b": null })
})
