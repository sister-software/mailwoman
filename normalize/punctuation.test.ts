/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { applyPunctuation } from "./punctuation.js"

test("applyPunctuation: input with no fancy punctuation is unchanged (identity map)", () => {
	const r = applyPunctuation("123 Main St")
	expect(r.text).toBe("123 Main St")
	expect(r.replacements).toBe(0)
	expect(r.map).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test("applyPunctuation: fancy quotes/dashes fold to ASCII, length-preserving", () => {
	const r = applyPunctuation("‘a’ “b”") // 'a' "b"
	expect(r.text).toBe("'a' \"b\"")
	expect(r.replacements).toBe(4)
	expect(r.map).toEqual([0, 1, 2, 3, 4, 5, 6]) // 1:1, so the map stays identity
})

test("applyPunctuation: the ellipsis expands 1→3 and the offset map points all 3 at the source index", () => {
	const r = applyPunctuation("a…b") // "a…b"
	expect(r.text).toBe("a...b")
	expect(r.replacements).toBe(1)
	// output: a . . . b  → source: 0 1 1 1 2  (the three dots all came from input index 1)
	expect(r.map).toEqual([0, 1, 1, 1, 2])
})

test("applyPunctuation: JP block-separator dashes (−, ―) fold to hyphen", () => {
	const r = applyPunctuation("1−2―3") // 1−2―3
	expect(r.text).toBe("1-2-3")
	expect(r.replacements).toBe(2)
})

test("applyPunctuation: empty input", () => {
	expect(applyPunctuation("")).toEqual({ text: "", map: [], replacements: 0 })
})
