/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the secondary-unit regex repair pass (parser-improvement backlog). Each case builds a
 *   char-aligned DecoderToken sequence (offsets must match the raw text) and asserts the repaired
 *   unit span. Covers ADD (model missed the unit), SNAP (model truncated it), single-letter idents
 *   ("STE D"), bare hash, smear-clip, and the precision guards (no-add-over-structural, no false
 *   match on "United"/"Box"/bare prose).
 */

import type { BioLabel, DecoderToken } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { repairUnitLabels } from "./unit-repair.js"

/** Build a char-aligned token. */
function tok(piece: string, start: number, end: number, label: BioLabel): DecoderToken {
	return { piece, start, end, label, confidence: 1 }
}

/** The contiguous unit value implied by the repaired labels (first B-…I-* run). */
function unitValue(text: string, tokens: DecoderToken[]): string | null {
	let start = -1
	let end = -1

	for (const t of tokens) {
		if (t.label === "B-unit") {
			if (start === -1) {
				start = t.start
				end = t.end
			}
		} else if (t.label === "I-unit" && start !== -1) {
			end = t.end
		} else if (start !== -1) {
			break // run ended
		}
	}

	return start === -1 ? null : text.slice(start, end)
}

describe("repairUnitLabels", () => {
	it("ADDs a unit the model missed (over O)", () => {
		const text = "123 Main St Apt 456"
		const tokens = [
			tok("123", 0, 3, "B-house_number"),
			tok("Main", 4, 8, "B-street"),
			tok("St", 9, 11, "I-street"),
			tok("Apt", 12, 15, "O"),
			tok("456", 16, 19, "O"),
		]
		const { tokens: out, changed } = repairUnitLabels(text, tokens)
		expect(changed).toBeGreaterThan(0)
		expect(unitValue(text, out)).toBe("Apt 456")
		// the street/number must be untouched.
		expect(out[0]!.label).toBe("B-house_number")
		expect(out[1]!.label).toBe("B-street")
	})

	it("SNAPs a truncated unit to the full shape (model labeled only the number)", () => {
		const text = "500 Main St Suite 100"
		const tokens = [
			tok("500", 0, 3, "B-house_number"),
			tok("Main", 4, 8, "B-street"),
			tok("St", 9, 11, "I-street"),
			tok("Suite", 12, 17, "O"),
			tok("100", 18, 21, "B-unit"),
		]
		const { tokens: out } = repairUnitLabels(text, tokens)
		expect(unitValue(text, out)).toBe("Suite 100")
	})

	it("handles a single-letter identifier (STE D)", () => {
		const text = "26601 Aliso Creek Road STE D"
		const tokens = [
			tok("26601", 0, 5, "B-house_number"),
			tok("Aliso", 6, 11, "B-street"),
			tok("Creek", 12, 17, "I-street"),
			tok("Road", 18, 22, "I-street"),
			tok("STE", 23, 26, "O"),
			tok("D", 27, 28, "O"),
		]
		const { tokens: out } = repairUnitLabels(text, tokens)
		expect(unitValue(text, out)).toBe("STE D")
	})

	it("ADDs a bare hash unit (#104)", () => {
		const text = "10 Downing St #104"
		const tokens = [
			tok("10", 0, 2, "B-house_number"),
			tok("Downing", 3, 10, "B-street"),
			tok("St", 11, 13, "I-street"),
			tok("#104", 14, 18, "O"),
		]
		const { tokens: out } = repairUnitLabels(text, tokens)
		expect(unitValue(text, out)).toBe("#104")
	})

	it("reclaims a bare unit the model mislabeled as locality (Flat 2 → unit)", () => {
		// The v0.7.2 failure mode: "Flat 2  14 Smith St" → model labels "Flat 2" as locality.
		const text = "Flat 2  14 Smith St"
		const tokens = [
			tok("Flat", 0, 4, "B-locality"),
			tok("2", 5, 6, "I-locality"),
			tok("14", 8, 10, "B-house_number"),
			tok("Smith", 11, 16, "B-street"),
			tok("St", 17, 19, "I-street"),
		]
		const { tokens: out, changed } = repairUnitLabels(text, tokens)
		expect(changed).toBeGreaterThan(0)
		expect(unitValue(text, out)).toBe("Flat 2")
		// the house_number/street must be untouched.
		expect(out[2]!.label).toBe("B-house_number")
		expect(out[3]!.label).toBe("B-street")
	})

	it("does NOT add over a structural tag (Apt where the number is a confident house_number)", () => {
		const text = "Apt 4"
		// pathological: model labeled "4" as house_number. ADD must be blocked.
		const tokens = [tok("Apt", 0, 3, "O"), tok("4", 4, 5, "B-house_number")]
		const { tokens: out, changed } = repairUnitLabels(text, tokens)
		expect(changed).toBe(0)
		expect(out[1]!.label).toBe("B-house_number") // untouched
	})

	it("does NOT match 'Box' (that is a po_box, not a unit)", () => {
		const text = "PO Box 324 Wellington"
		const tokens = [
			tok("PO", 0, 2, "B-po_box"),
			tok("Box", 3, 6, "I-po_box"),
			tok("324", 7, 10, "I-po_box"),
			tok("Wellington", 11, 21, "B-locality"),
		]
		const { tokens: out, changed } = repairUnitLabels(text, tokens)
		expect(changed).toBe(0)
		expect(unitValue(text, out)).toBeNull()
	})

	it("does NOT match 'Unit' inside 'United' or other prose", () => {
		const text = "United States Department"
		const tokens = [tok("United", 0, 6, "B-country"), tok("States", 7, 13, "I-country"), tok("Department", 14, 24, "O")]
		const { tokens: out, changed } = repairUnitLabels(text, tokens)
		expect(changed).toBe(0)
		expect(unitValue(text, out)).toBeNull()
	})

	it("clips smear: a stray unit label past the match is trimmed", () => {
		const text = "Apt 4 Springfield"
		const tokens = [
			tok("Apt", 0, 3, "B-unit"),
			tok("4", 4, 5, "I-unit"),
			tok("Springfield", 6, 17, "I-unit"), // model smeared the unit onto the city
		]
		const { tokens: out } = repairUnitLabels(text, tokens)
		expect(unitValue(text, out)).toBe("Apt 4")
		expect(out.find((t) => t.piece === "Springfield")!.label).toBe("O")
	})

	it("is a no-op when no unit shape is present", () => {
		const text = "Main Street Springfield"
		const tokens = [
			tok("Main", 0, 4, "B-street"),
			tok("Street", 5, 11, "I-street"),
			tok("Springfield", 12, 23, "B-locality"),
		]
		const { tokens: out, changed } = repairUnitLabels(text, tokens)
		expect(changed).toBe(0)
		expect(out.map((t) => t.label)).toEqual(tokens.map((t) => t.label))
	})
})
