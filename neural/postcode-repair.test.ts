/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the v0.7 #35 postcode regex repair pass. Each case constructs a char-aligned
 *   DecoderToken sequence (offsets must match the raw text) and asserts the repaired postcode span.
 *   Covers the four failure modes from the 2026-05-29 diagnostic plus the precision guards
 *   (longest-match-wins, SNAP-only for numeric shapes, no-add-over-structural, local smear-clip).
 */

import type { BIOLabel, DecoderToken } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { repairPostcodeLabels } from "./postcode-repair.js"

/** Build a char-aligned token. */
function tok(piece: string, start: number, end: number, label: BIOLabel): DecoderToken {
	return { piece, start, end, label, confidence: 1 }
}

/** The contiguous postcode value implied by the repaired labels (first B-…I-* run). */
function postcodeValue(text: string, tokens: DecoderToken[]): string | null {
	let start = -1
	let end = -1

	for (const t of tokens) {
		if (t.label === "B-postcode") {
			if (start === -1) {
				start = t.start
				end = t.end
			}
		} else if (t.label === "I-postcode" && start !== -1) {
			end = t.end
		} else if (start !== -1) {
			break // run ended
		}
	}

	return start === -1 ? null : text.slice(start, end)
}

/** The contiguous locality value implied by the repaired labels (first B-…I-locality run). */
function localityValue(text: string, tokens: DecoderToken[]): string | null {
	let start = -1
	let end = -1

	for (const t of tokens) {
		if (t.label === "B-locality") {
			if (start === -1) {
				start = t.start
				end = t.end
			} else break
		} else if (t.label === "I-locality" && start !== -1) {
			end = t.end
		} else if (start !== -1) {
			break
		}
	}

	return start === -1 ? null : text.slice(start, end)
}

describe("repairPostcodeLabels", () => {
	it("ADDs an alphanumeric postcode the model missed (GB), over O/locality", () => {
		const text = "London SW1A 1AA"
		// model labeled the postcode tokens O — total miss.
		const tokens = [tok("London", 0, 6, "B-locality"), tok("SW1A", 7, 11, "O"), tok("1AA", 12, 15, "O")]
		const { tokens: out, changed } = repairPostcodeLabels(text, tokens)
		expect(changed).toBeGreaterThan(0)
		expect(postcodeValue(text, out)).toBe("SW1A 1AA")
	})

	it("SNAPs a truncated postcode to the full shape (CA M5V 2T6)", () => {
		const text = "Toronto ON M5V 2T6"
		// model labeled only "2T6" as postcode (truncation).
		const tokens = [
			tok("Toronto", 0, 7, "B-locality"),
			tok("ON", 8, 10, "B-region"),
			tok("M5V", 11, 14, "O"),
			tok("2T6", 15, 18, "B-postcode"),
		]
		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("M5V 2T6")
	})

	it("longest-match-wins: US ZIP+4 beats the NL-shaped tail (94610-2737 CA → not 2737 CA)", () => {
		const text = "Oakland 94610-2737 CA"
		const tokens = [
			tok("Oakland", 0, 7, "B-locality"),
			tok("94610-2737", 8, 18, "B-postcode"), // model got it right
			tok("CA", 19, 21, "B-region"),
		]
		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("94610-2737")
		// CA must NOT have been pulled into the postcode.
		expect(out.find((t) => t.piece === "CA")!.label).not.toBe("I-postcode")
	})

	it("clips smear: postcode label bleeding onto a neighbour is trimmed to the match", () => {
		const text = "Paris 75008 France"
		// model smeared the postcode onto "France".
		const tokens = [
			tok("Paris", 0, 5, "B-locality"),
			tok("75008", 6, 11, "B-postcode"),
			tok("France", 12, 18, "I-postcode"),
		]
		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("75008")
		expect(out.find((t) => t.piece === "France")!.label).toBe("O")
	})

	it("hands a trailing over-extension BACK to the city (DE postcode→city absorption)", () => {
		// The model swallowed the city's leading "Pl" into the postcode span ("08523 Pl|auen").
		const text = "08523 Plauen"
		const tokens = [
			tok("08523", 0, 5, "B-postcode"),
			tok("Pl", 6, 8, "I-postcode"), // over-extension: the city's first chars
			tok("auen", 8, 12, "B-locality"), // the city remainder
		]
		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(postcodeValue(text, out)).toBe("08523")
		// "Pl" is reassigned to locality and merged with "auen" into one span → "Plauen".
		expect(localityValue(text, out)).toBe("Plauen")
	})

	it("does NOT add a numeric postcode from scratch (a bare 5-digit could be a house number)", () => {
		const text = "12345 Main St"
		// 12345 is a house number the model labeled correctly; no postcode present.
		const tokens = [tok("12345", 0, 5, "B-house_number"), tok("Main", 6, 10, "B-street"), tok("St", 11, 13, "I-street")]
		const { tokens: out, changed } = repairPostcodeLabels(text, tokens)
		expect(changed).toBe(0)
		expect(postcodeValue(text, out)).toBeNull()
	})

	it("does NOT add over a structural tag even for an alphanumeric shape", () => {
		const text = "1012 AB"
		// model labeled "1012" as house_number — ADD must be blocked (structural tag present).
		const tokens = [tok("1012", 0, 4, "B-house_number"), tok("AB", 5, 7, "O")]
		const { tokens: out } = repairPostcodeLabels(text, tokens)
		expect(out[0]!.label).toBe("B-house_number") // untouched
	})

	it("is a no-op when no postcode shape is present", () => {
		const text = "Main Street Springfield"
		const tokens = [
			tok("Main", 0, 4, "B-street"),
			tok("Street", 5, 11, "I-street"),
			tok("Springfield", 12, 23, "B-locality"),
		]
		const { tokens: out, changed } = repairPostcodeLabels(text, tokens)
		expect(changed).toBe(0)
		expect(out.map((t) => t.label)).toEqual(tokens.map((t) => t.label))
	})
})
