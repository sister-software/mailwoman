/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mulberry32 } from "@mailwoman/core/random"
import { describe, expect, test } from "vitest"

import { PackedStringMap } from "#latn/packed-string-map"

/**
 * Latin-script letters at each UTF-8 width the table measures: one byte (`a`), two (`é`, `ß`, `ł`, `ä`)
 * and three (`ḁ` U+1E01, `ẞ` U+1E9E), plus the separators the lexicons' n-grams contain.
 *
 * The emoji is the four-byte case.
 * It is a symbol that typed address input can contain, rather than a script the lexicons cover.
 */
const ALPHABET = ["a", "b", "é", "ß", "ł", "ḁ", "ẞ", " ", "-", "1", "😀", "ä"]

/**
 * Builds seeded random keys from {@link ALPHABET}.
 */
function randomKeys(seed: number, count: number): string[] {
	const random = mulberry32(seed)

	return Array.from({ length: count }, () =>
		Array.from({ length: 1 + Math.floor(random() * 12) }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join(
			""
		)
	)
}

describe("PackedStringMap", () => {
	test("answers get and has as a Map built from the same entries", () => {
		const keys = randomKeys(5, 20_000)
		const random = mulberry32(9)
		const entries = keys.map((key) => [key, Math.floor(random() * 2 ** 31) - 2 ** 30] as const)
		const reference = new Map(entries)
		const packed = PackedStringMap.from(entries)

		expect(packed.size).toBe(reference.size)

		for (const key of [...reference.keys(), ...randomKeys(11, 5000), "", "zzz"]) {
			expect(packed.get(key)).toBe(reference.get(key))
			expect(packed.has(key)).toBe(reference.has(key))
		}
	})

	test("reads a parsed JSON object, and a later duplicate pair replaces an earlier one", () => {
		expect(PackedStringMap.from({ paris: 1, lyon: 3 }).get("lyon")).toBe(3)

		const packed = PackedStringMap.from([
			["köln", 1],
			["köln", 2],
		])

		expect(packed.get("köln")).toBe(2)
		expect(packed.size).toBe(1)
	})

	test("an empty table answers undefined", () => {
		const packed = PackedStringMap.from({})

		expect(packed.size).toBe(0)
		expect(packed.get("paris")).toBeUndefined()
	})

	test("refuses a value outside the 32-bit integer range", () => {
		expect(() => PackedStringMap.from({ paris: 1.5 })).toThrow(RangeError)
		expect(() => PackedStringMap.from({ paris: 2 ** 31 })).toThrow(RangeError)
	})
})
