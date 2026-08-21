/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the vocabulary coverage measurement, driven by a stub tokenizer.
 *
 *   Stubbed on purpose: loading the real 9 MB SentencePiece model to assert that a `<0x..>` piece is counted as a
 *   fallback would test SentencePiece, not this. What IS worth pinning is the arithmetic a reader will quote — the
 *   share's denominator is PIECES and not characters, and the per-character verdict is taken from the character ALONE
 *   rather than from its behaviour inside a word.
 */

import { __testing } from "@mailwoman/dev-mcp/vocabulary"
import { describe, expect, it } from "vitest"

const { characterCoverage, measureLine, total } = __testing

/**
 * Encodes each character as itself, except those in `absent`, which become one `<0xNN>` piece per UTF-8 byte — the
 * shape SentencePiece produces for a codepoint outside the vocabulary.
 */
const stub = (absent: string) => ({
	encode: (text: string) => ({
		pieces: [...text].flatMap((c) =>
			absent.includes(c)
				? [...new TextEncoder().encode(c)].map((b) => ({ piece: `<0x${b.toString(16).toUpperCase()}>` }))
				: [{ piece: c }]
		),
	}),
})

describe("measureLine", () => {
	it("counts a fallback per BYTE, which is why a shattered word costs more pieces than characters", () => {
		// "ư" is 2 UTF-8 bytes, so one absent character becomes two pieces.
		const line = measureLine(stub("ư"), "Đư", false)

		expect(line.characters).toBe(2)
		expect(line.pieces).toBe(3)
		expect(line.byteFallbacks).toBe(2)
		expect(line.piecesPerCharacter).toBeCloseTo(1.5)
	})

	it("reports a fully-covered line as zero fallbacks", () => {
		expect(measureLine(stub(""), "Baker Street", false).byteFallbacks).toBe(0)
	})

	it("emits the piece sequence only when asked — it is what shows WHERE a word shatters, and what makes a reply long", () => {
		expect(measureLine(stub("ư"), "Đư", false).sequence).toBeUndefined()
		expect(measureLine(stub("ư"), "Đư", true).sequence).toBe("Đ|<0xC6>|<0xB0>")
	})
})

describe("total", () => {
	it("takes the fallback share over PIECES, not characters — the denominator a reader will quote", () => {
		const lines = [measureLine(stub("ư"), "Đư", false), measureLine(stub(""), "abc", false)]
		const t = total(lines)

		expect(t.pieces).toBe(6)
		expect(t.characters).toBe(5)
		expect(t.byteFallbacks).toBe(2)
		expect(t.byteFallbackShare).toBeCloseTo(2 / 6)
	})

	it("answers zero rather than NaN for an empty set", () => {
		expect(total([])).toMatchObject({ piecesPerCharacter: 0, byteFallbackShare: 0 })
	})
})

describe("characterCoverage", () => {
	it("judges each character ALONE, so a lucky segmentation cannot report an absent codepoint as covered", () => {
		const coverage = characterCoverage(stub("ư"), ["Đường"])

		expect(coverage.byteFallback).toEqual(["ư"])
		expect(coverage.inVocabulary).toContain("Đ")
		expect(coverage.inVocabulary).toContain("n")
	})

	it("ignores digits, punctuation and spaces — a vocabulary decision is about letters", () => {
		const coverage = characterCoverage(stub(""), ["01 Đường, Buôn"])

		expect(coverage.inVocabulary).not.toContain("0")
		expect(coverage.inVocabulary).not.toContain(",")
		expect(coverage.inVocabulary).not.toContain(" ")
	})
})
