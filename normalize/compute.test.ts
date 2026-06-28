/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { normalize } from "./compute.js"

describe("normalize — defaults", () => {
	it("returns identity for already-clean input", () => {
		const r = normalize("350 5th Ave")
		expect(r.normalized).toBe("350 5th Ave")
		expect(r.transforms.every((t) => t.kind === "nfc")).toBe(true)
	})

	it("collapses double-spaces by default", () => {
		const r = normalize("350  5th Ave")
		expect(r.normalized).toBe("350 5th Ave")
		expect(r.transforms.some((t) => t.kind === "collapse_whitespace")).toBe(true)
	})

	it("normalizes fancy quotes", () => {
		const r = normalize("“hello”")
		expect(r.normalized).toBe('"hello"')
	})

	it("trims leading/trailing whitespace", () => {
		const r = normalize("   350 5th Ave   ")
		expect(r.normalized).toBe("350 5th Ave")
	})

	it("preserves case by default", () => {
		const r = normalize("New York")
		expect(r.normalized).toBe("New York")
	})

	it("does not expand abbreviations by default", () => {
		const r = normalize("350 5th Ave")
		expect(r.normalized).toBe("350 5th Ave")
	})
})

describe("normalize — opts", () => {
	it("caseFold lowercases", () => {
		const r = normalize("NEW YORK", { caseFold: true, locale: "en-US" })
		expect(r.normalized).toBe("new york")
	})

	it("expandAbbreviations + locale en-US", () => {
		const r = normalize("350 5th St NW", { expandAbbreviations: true })
		expect(r.normalized).toBe("350 5th Street Northwest")
	})

	it("expandAbbreviations + locale fr-FR", () => {
		const r = normalize("8 R République", { expandAbbreviations: true, locale: "fr-FR" })
		expect(r.normalized).toBe("8 Rue République")
	})

	it("combined caseFold + expandAbbreviations", () => {
		const r = normalize("350 5TH ST", { caseFold: true, expandAbbreviations: true })
		// caseFold runs before abbreviations; "st" matches dict
		expect(r.normalized).toBe("350 5th street")
	})
})

describe("normalize — offsetMap invariants", () => {
	it("offsetMap length === normalized length", () => {
		const inputs = ["350 5th Ave", "350  5th Ave", "  hello  ", "St", "Ave"]

		for (const inp of inputs) {
			const r = normalize(inp)
			expect(r.offsetMap.length).toBe(r.normalized.length)
		}
	})

	it("offsetMap entries are all valid indices into raw", () => {
		const r = normalize("350  5th Ave")

		for (const idx of r.offsetMap) {
			expect(idx).toBeGreaterThanOrEqual(0)
			expect(idx).toBeLessThan(r.raw.length)
		}
	})

	it("preserves identity-map for clean input", () => {
		const r = normalize("350 5th Ave")
		expect(r.offsetMap).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
	})

	it("offsetMap correctness after whitespace collapse", () => {
		// raw:  "350  5th"  (length 8, double space at 3,4)
		// norm: "350 5th"   (length 7)
		const r = normalize("350  5th")
		expect(r.normalized).toBe("350 5th")
		expect(r.offsetMap[0]).toBe(0) // '3' → 0
		expect(r.offsetMap[3]).toBe(3) // ' ' → 3 (first space)
		expect(r.offsetMap[4]).toBe(5) // '5' → 5 (skipped position 4)
	})

	it("offsetMap correctness after trim", () => {
		const r = normalize("   ABC   ")
		expect(r.normalized).toBe("ABC")
		expect(r.offsetMap).toEqual([3, 4, 5])
	})

	it("offsetMap correctness after abbreviation expansion", () => {
		const r = normalize("Ave", { expandAbbreviations: true })
		expect(r.normalized).toBe("Avenue")

		// All chars point back into the source "Ave" range (0..2)
		for (const idx of r.offsetMap) {
			expect(idx).toBeGreaterThanOrEqual(0)
			expect(idx).toBeLessThanOrEqual(2)
		}
	})
})

describe("normalize — raw preserved + frozen", () => {
	it("raw field is the original input", () => {
		const raw = "  350  5th  Ave  "
		const r = normalize(raw)
		expect(r.raw).toBe(raw)
	})

	it("returns a frozen object", () => {
		const r = normalize("350 5th Ave")
		expect(Object.isFrozen(r)).toBe(true)
	})
})
