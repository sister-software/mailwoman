/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { normalize } from "@mailwoman/normalize"
import { spaceAfterComma } from "@mailwoman/normalize/comma-spacing"
import { expect, test } from "vitest"

test("spaceAfterComma: a comma glued to a letter gains one space that maps to the comma", () => {
	const r = spaceAfterComma("Biggin Hill,United Kingdom")
	expect(r.text).toBe("Biggin Hill, United Kingdom")
	expect(r.inserted).toBe(1)
	// "Biggin Hill," is indices 0–11; the inserted space also points at the comma (11); "U" is raw index 12.
	expect(r.map.slice(10, 14)).toEqual([10, 11, 11, 12])
	expect(r.map).toHaveLength(r.text.length)
})

test("spaceAfterComma: a numeric separator, a spaced comma, punctuation or the end is left as typed", () => {
	for (const input of ["12,5", "1,000 Main St", "Paris, France", "trailing,", "x, y", "a,;b", "€1,5,000"]) {
		const r = spaceAfterComma(input)
		expect(r.text, input).toBe(input)
		expect(r.inserted, input).toBe(0)
		expect(r.map, input).toEqual([...input].map((_, i) => i))
	}
})

test("spaceAfterComma: a letter or a digit after the comma triggers it, at every tight comma in the input", () => {
	const r = spaceAfterComma("Neusser Str. 12,Nippes,50733 Köln,Straße,Übersee,,x")
	expect(r.text).toBe("Neusser Str. 12, Nippes, 50733 Köln, Straße, Übersee,, x")
	expect(r.inserted).toBe(5)
})

test("normalize: the transform is reported, and a comma already followed by a space is never doubled", () => {
	const tight = normalize("Biggin Hill,United Kingdom")
	expect(tight.normalized).toBe("Biggin Hill, United Kingdom")
	expect(tight.transforms).toContainEqual({ kind: "space_after_comma", inserted: 1 })
	expect(tight.offsetMap[12]).toBe(11)
	expect(tight.offsetMap[13]).toBe(12)

	const spaced = normalize("Biggin Hill, United Kingdom")
	expect(spaced.normalized).toBe("Biggin Hill, United Kingdom")
	expect(spaced.transforms.some((t) => t.kind === "space_after_comma")).toBe(false)
})
