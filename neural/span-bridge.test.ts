/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Contract tests for punctuation-gap span bridging (the v4.4.0 corrective). Essential properties:
 *   dotted fragments merge through their punctuation O-tokens; space-only gaps NEVER merge (the
 *   Saint-Albans guard); different tags never merge; the merged confidence is the minimum of the
 *   fragments.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { bridgePunctuationGaps } from "./span-bridge.ts"

const tok = (piece: string, start: number, label: string, confidence = 0.9): DecoderToken =>
	({ piece, start, end: start + piece.length, label, confidence }) as DecoderToken

describe("bridgePunctuationGaps", () => {
	it("merges dotted po_box fragments through period O-tokens", () => {
		// "P.O. BOX 19" — P[0,1) .[1,2) O[2,3) .[3,4) BOX 19[5,11)
		const text = "P.O. BOX 19"
		const input = [
			tok("P", 0, "B-po_box", 0.93),
			tok(".", 1, "O"),
			tok("O", 2, "B-po_box", 0.94),
			tok(".", 3, "O"),
			tok("BOX 19", 5, "B-po_box", 0.96),
		]
		const out = bridgePunctuationGaps(text, input)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ piece: "P.O. BOX 19", start: 0, end: 11, label: "B-po_box" })
		expect(out[0]!.confidence).toBeCloseTo(0.93)
	})

	it("does NOT merge across space-only gaps (Saint-Albans guard)", () => {
		const text = "Saint Paul"
		const input = [tok("Saint", 0, "B-locality"), tok("Paul", 6, "B-locality")]
		expect(bridgePunctuationGaps(text, input)).toHaveLength(2)
	})

	it("does NOT merge different tags", () => {
		const text = "VT. 05751"
		const input = [tok("VT", 0, "B-region"), tok(".", 2, "O"), tok("05751", 4, "B-postcode")]
		expect(bridgePunctuationGaps(text, input)).toHaveLength(3)
	})

	it("does NOT merge across separator punctuation (the FR comma class)", () => {
		// "…47110, 9016…" — the model double-labels the house number as a second postcode
		// fragment; the comma is the only thing keeping the spans honest. Never bridge it.
		const text = "47110, 9016"
		const input = [tok("47110", 0, "B-postcode"), tok(",", 5, "O"), tok("9016", 7, "B-postcode")]
		expect(bridgePunctuationGaps(text, input)).toHaveLength(3)
	})

	it("does NOT merge across long gaps", () => {
		const text = "Box 12 --- Box 99"
		const input = [tok("Box 12", 0, "B-po_box"), tok("Box 99", 11, "B-po_box")]
		expect(bridgePunctuationGaps(text, input)).toHaveLength(2)
	})

	it("does NOT merge when a labeled token sits in the gap range", () => {
		// Pathological overlap: a non-O token between the fragments blocks the bridge.
		const text = "A.B"
		const input = [tok("A", 0, "B-venue"), tok(".", 1, "B-street"), tok("B", 2, "B-venue")]
		expect(bridgePunctuationGaps(text, input)).toHaveLength(3)
	})

	it("merges comma-gap C.P. style fragments and absorbs the O token", () => {
		const text = "C.P. 220"
		const input = [
			tok("C", 0, "B-po_box", 0.6),
			tok(".", 1, "O"),
			tok("P", 2, "I-po_box", 0.97),
			tok(".", 3, "O"),
			tok("220", 5, "I-po_box", 0.94),
		]
		const out = bridgePunctuationGaps(text, input)
		expect(out).toHaveLength(1)
		expect(out[0]!.piece).toBe("C.P. 220")
		expect(out[0]!.confidence).toBeCloseTo(0.6)
	})

	it("leaves O-only streams and plain spans untouched", () => {
		const text = "PO Box 989"
		const input = [tok("PO Box 989", 0, "B-po_box")]
		expect(bridgePunctuationGaps(text, input)).toEqual(input)
	})

	describe("crossing constraint (M2 — Stage 2.7 structural boundaries)", () => {
		it("blocks a same-tag merge whose gap contains a proposed span boundary", () => {
			// "Joe's 'Pizza' Shop" with a quoted span over 'Pizza' — the gap " '" between two venue
			// fragments is bridgeable (apostrophe + space), but the opening quote at index 6 is a
			// structural boundary the merge must not straddle.
			const text = "Joe's 'Pizza' Shop"
			const input = [tok("Joe's", 0, "B-venue"), tok("Pizza", 7, "B-venue")]
			// Without the constraint the bridge merges (regression guard for the test itself):
			expect(bridgePunctuationGaps(text, input)).toHaveLength(1)
			const out = bridgePunctuationGaps(text, input, { blockedSpans: [{ start: 6, end: 13 }] })
			expect(out).toHaveLength(2)
		})

		it("blocks a merge across a CLOSING boundary", () => {
			// Closing quote at index 12 sits inside the gap "' " between the fragments.
			const text = "Joe's 'Pizza' Shop"
			const input = [tok("Pizza", 7, "B-venue"), tok("Shop", 14, "B-venue")]
			expect(bridgePunctuationGaps(text, input)).toHaveLength(1)
			const out = bridgePunctuationGaps(text, input, { blockedSpans: [{ start: 6, end: 13 }] })
			expect(out).toHaveLength(2)
		})

		it("still merges when the boundary is elsewhere (dotted po_box stays bridged)", () => {
			const text = "P.O. BOX 19 (rear)"
			const input = [
				tok("P", 0, "B-po_box", 0.93),
				tok(".", 1, "O"),
				tok("O", 2, "B-po_box", 0.94),
				tok(".", 3, "O"),
				tok("BOX 19", 5, "B-po_box", 0.96),
			]
			const out = bridgePunctuationGaps(text, input, { blockedSpans: [{ start: 12, end: 18 }] })
			expect(out).toHaveLength(1)
			expect(out[0]!.piece).toBe("P.O. BOX 19")
		})

		it("no blocked spans = byte-identical to the unconstrained bridge", () => {
			const text = "P.O. BOX 19"
			const input = [tok("P", 0, "B-po_box"), tok(".", 1, "O"), tok("O", 2, "B-po_box"), tok("BOX 19", 5, "I-po_box")]
			expect(bridgePunctuationGaps(text, input, {})).toEqual(bridgePunctuationGaps(text, input))
		})
	})
})
