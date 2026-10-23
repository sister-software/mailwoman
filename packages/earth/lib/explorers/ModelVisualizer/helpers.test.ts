/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure-function tests for the ModelVisualizer render helpers. The browser suite validates rendering
 *   via Storybook (ModelVisualizer.stories.tsx) against the committed fixture.
 */

import type { NeuralParseTrace } from "@mailwoman/neural"
import type { ParseTraceLike } from "mailwoman/browser-runtime/types"
import { describe, expect, it } from "vitest"

import {
	changedIndices,
	coveringTokenIndex,
	emissionColor,
	familyOrder,
	flipsAfterRemoval,
	labelFamily,
	labelHue,
	matrixAbsMax,
	moveTile,
	pieceDisplay,
	runnerUp,
	tilesOf,
} from "#explorers/ModelVisualizer/helpers"

import fixture from "./white-house.trace.json" with { type: "json" }

// Compile-time tie (type-only, erased at build): the docs mirror must accept every real trace.
// A NeuralParseTrace field rename/retype now fails here at typecheck instead of at runtime on /trace.
const _traceMirrorAccepts: ParseTraceLike = {} as NeuralParseTrace

void _traceMirrorAccepts

describe("ModelVisualizer helpers", () => {
	it("matrixAbsMax ignores the conventions-mask sentinel", () => {
		expect(
			matrixAbsMax([
				[1, -2],
				[-1e9, 3],
			])
		).toBe(3)

		expect(matrixAbsMax([])).toBe(1)
	})

	it("emissionColor is diverging and clamps", () => {
		expect(emissionColor(0, 5)).toContain("0%")
		expect(emissionColor(5, 5)).not.toBe(emissionColor(-5, 5))
		expect(emissionColor(500, 5)).toBe(emissionColor(5, 5))
	})

	it("pieceDisplay swaps the SP space sentinel for a visible marker", () => {
		expect(pieceDisplay("▁Ave")).toBe("␣Ave")
		expect(pieceDisplay("Ave")).toBe("Ave")
	})

	it("changedIndices finds label diffs", () => {
		expect(changedIndices(["O", "O", "O"], ["O", "B-postcode", "I-postcode"])).toEqual([1, 2])
		expect(changedIndices(["O"], ["O"])).toEqual([])
	})

	it("the committed fixture satisfies ParseTraceLike's alignment invariants", () => {
		const trace = fixture as ParseTraceLike

		expect(trace.labels.length).toBeGreaterThan(0)
		expect(trace.logits).toHaveLength(trace.pieces.length)
		expect(trace.emissions).toHaveLength(trace.pieces.length)
		expect(trace.path).toHaveLength(trace.pieces.length)
		expect(trace.tokens).toHaveLength(trace.pieces.length)

		// The label vocabulary may prefix-extend the model's emission width
		// (Stage-prefix rule — see neural/labels.ts + assertEmissionWidth):
		// rows are uniform and never wider than labels.
		const width = trace.logits[0]?.length ?? 0

		expect(width).toBeGreaterThan(0)
		expect(width).toBeLessThanOrEqual(trace.labels.length)

		for (const row of trace.logits) {
			expect(row).toHaveLength(width)
		}

		for (const idx of trace.path) {
			expect(idx).toBeLessThan(trace.labels.length)
		}

		for (const repair of trace.repairs) {
			expect(repair.before).toHaveLength(trace.pieces.length)
			expect(repair.after).toHaveLength(trace.pieces.length)
		}

		if (trace.localeLogits) {
			// Self-describing axis: the trace records the country order its logits mean —
			// the gauge (and this test) key off it rather than a hardcoded class count.
			expect(trace.localeCountries).toBeDefined()
			expect(trace.localeLogits).toHaveLength(trace.localeCountries!.length)
		}
	})
})

describe("workbench helpers (#2820)", () => {
	it("labelFamily drops the BIO prefix so both halves of a span share one family", () => {
		expect(labelFamily("B-locality")).toBe("locality")
		expect(labelFamily("I-locality")).toBe("locality")
		expect(labelFamily("O")).toBe("O")
	})

	it("familyOrder lists each family once, in label order, without O", () => {
		expect(familyOrder(["O", "B-country", "I-country", "B-street", "I-street", "B-locality"])).toEqual([
			"country",
			"street",
			"locality",
		])
	})

	it("labelHue is one hue per family, null for O, and never repeats across the fixture's families", () => {
		const order = familyOrder((fixture as ParseTraceLike).labels)

		expect(labelHue("B-street", order)).toBe(labelHue("I-street", order))
		expect(labelHue("O", order)).toBeNull()
		expect(labelHue("B-unknown", order)).toBeNull()

		const hues = order.map((family) => labelHue(`B-${family}`, order))

		expect(new Set(hues).size).toBe(order.length)

		for (const hue of hues) {
			expect(hue).toBeGreaterThanOrEqual(0)
			expect(hue).toBeLessThan(360)
		}
	})

	it("tilesOf splits on any whitespace, newlines included, and keeps punctuation on its word", () => {
		expect(tilesOf("10 Downing St,\nLondon  SW1A 2AA\n")).toEqual(["10", "Downing", "St,", "London", "SW1A", "2AA"])
		expect(tilesOf("   ")).toEqual([])
	})

	it("moveTile moves one tile to the dropped slot and leaves the rest in order", () => {
		expect(moveTile(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
		expect(moveTile(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"])
		expect(moveTile(["a", "b"], 5, 0)).toEqual(["a", "b"])
	})

	it("flipsAfterRemoval matches probe tokens to their base twins through the removed span", () => {
		// Base: "A B C" with tokens at 0, 2, 4.
		// The removal of "B" (offset 2, two characters with its space) leaves "A C" with C at offset 2.
		// That offset maps back to 4.
		const base = [
			{ piece: "▁A", start: 0, end: 1, label: "B-venue", confidence: 1 },
			{ piece: "▁B", start: 2, end: 3, label: "B-street", confidence: 1 },
			{ piece: "▁C", start: 4, end: 5, label: "B-locality", confidence: 1 },
		]

		const probe = [
			{ piece: "▁A", start: 0, end: 1, label: "B-venue", confidence: 1 },
			{ piece: "▁C", start: 2, end: 3, label: "B-region", confidence: 1 },
		]

		expect(flipsAfterRemoval(base, probe, 2, 2)).toEqual([{ piece: "▁C", before: "B-locality", after: "B-region" }])

		expect(
			flipsAfterRemoval(
				base,
				base.filter((token) => token.start !== 4),
				4,
				2
			)
		).toEqual([])
	})

	it("coveringTokenIndex maps a character to the token whose span holds it, and a gap to -1", () => {
		const tokens = [
			{ start: 0, end: 4 },
			{ start: 5, end: 11 },
		]

		expect(coveringTokenIndex(tokens, 0)).toBe(0)
		expect(coveringTokenIndex(tokens, 3)).toBe(0)
		expect(coveringTokenIndex(tokens, 4)).toBe(-1)
		expect(coveringTokenIndex(tokens, 10)).toBe(1)
		expect(coveringTokenIndex(tokens, 11)).toBe(-1)
	})

	it("runnerUp reads the best other unmasked label and the chosen label's lead over it", () => {
		const labels = ["O", "B-street", "B-locality", "B-postcode"]

		expect(runnerUp([0.5, 2, 1.5, -1e9], labels, 1)).toEqual({ index: 2, label: "B-locality", gap: 0.5 })
		expect(runnerUp([-1e9, 2, -1e9, -1e9], labels, 1)).toBeNull()
	})

	it("runnerUp against the fixture never answers the chosen label or a masked cell", () => {
		const trace = fixture as ParseTraceLike

		trace.emissions.forEach((row, i) => {
			const chosen = trace.path[i]!
			const other = runnerUp(row, trace.labels, chosen)

			if (other) {
				expect(other.index).not.toBe(chosen)
				expect(row[other.index]).toBeGreaterThan(-1e8)
			}
		})
	})
})
