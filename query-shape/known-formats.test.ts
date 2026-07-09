/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { classifyToken, tokenizeForClass } from "./character-class.ts"
import { detectKnownFormats } from "./known-formats.ts"
import type { KnownFormat, TokenClass } from "./types.ts"

function tokenize(text: string): TokenClass[] {
	return tokenizeForClass(text).map((span) => ({
		span,
		class: classifyToken(span.body),
		length: span.end - span.start,
	}))
}

function formatsOf(text: string): KnownFormat[] {
	return detectKnownFormats(text, tokenize(text)).map((h) => h.format)
}

describe("detectKnownFormats — postcodes", () => {
	it("detects US ZIP+4 unambiguously", () => {
		expect(formatsOf("10118-1234")).toContain("us_zip4")
	})

	it("detects CA postcode (no space)", () => {
		const formats = formatsOf("K1A0B1")
		expect(formats).toContain("ca_postcode")
	})

	it("detects CA postcode (with space)", () => {
		const formats = formatsOf("K1A 0B1")
		expect(formats).toContain("ca_postcode")
	})

	it("detects JP postcode", () => {
		expect(formatsOf("100-0005")).toContain("jp_postcode")
	})

	it("detects UK postcode (no space)", () => {
		expect(formatsOf("SW1A1AA")).toContain("uk_postcode")
	})

	it("detects UK postcode (with space)", () => {
		expect(formatsOf("SW1A 1AA")).toContain("uk_postcode")
	})

	it("emits all three of US/FR/DE for ambiguous 5-digit", () => {
		const formats = formatsOf("10118")
		expect(formats).toContain("us_zip")
		expect(formats).toContain("fr_postcode")
		expect(formats).toContain("de_postcode")
	})

	it("ambiguous 5-digit confidence is lower than unambiguous", () => {
		const hits = detectKnownFormats("10118", tokenize("10118"))
		expect(hits.every((h) => h.confidence < 0.9)).toBe(true)
	})

	it("unambiguous patterns score ≥ 0.9", () => {
		const hits = detectKnownFormats("10118-1234", tokenize("10118-1234"))
		const z4 = hits.find((h) => h.format === "us_zip4")!
		expect(z4.confidence).toBeGreaterThanOrEqual(0.9)
	})

	it("no postcode match for short numbers", () => {
		expect(formatsOf("123")).not.toContain("us_zip")
		expect(formatsOf("12345-67")).not.toContain("us_zip4")
	})
})

describe("detectKnownFormats — PO Box", () => {
	it("detects 'PO Box 1234'", () => {
		expect(formatsOf("PO Box 1234")).toContain("po_box")
	})

	it("detects 'P.O. Box 1234'", () => {
		expect(formatsOf("P.O. Box 1234")).toContain("po_box")
	})

	it("detects French 'BP 42'", () => {
		expect(formatsOf("BP 42")).toContain("po_box")
	})

	it("does not detect a lone 'box'", () => {
		expect(formatsOf("box 1234")).toContain("po_box") // 'box' is a valid leader on its own
		expect(formatsOf("just box")).not.toContain("po_box") // no following number
	})

	it("does not detect random words", () => {
		expect(formatsOf("hello world")).not.toContain("po_box")
	})
})

describe("detectKnownFormats — span correctness", () => {
	it("spans cover the matched substring", () => {
		const text = "350 5th Ave, New York, NY 10118"
		const hits = detectKnownFormats(text, tokenize(text))
		const usZip = hits.find((h) => h.format === "us_zip")!
		expect(usZip).toBeDefined()
		expect(text.slice(usZip.span.start, usZip.span.end)).toBe("10118")
	})

	it("two-token spans cover both tokens + the separating space", () => {
		const text = "SW1A 1AA"
		const hits = detectKnownFormats(text, tokenize(text))
		const uk = hits.find((h) => h.format === "uk_postcode")!
		expect(text.slice(uk.span.start, uk.span.end)).toBe("SW1A 1AA")
	})
})
