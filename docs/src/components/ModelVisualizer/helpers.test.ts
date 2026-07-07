/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure-function tests for the ModelVisualizer render helpers. Rendering itself is validated
 *   via Storybook (ModelVisualizer.stories.tsx) against the committed fixture.
 */

import type { NeuralParseTrace } from "@mailwoman/neural"
import { describe, expect, it } from "vitest"

import type { ParseTraceLike } from "../../shared/resources.tsx"
import fixture from "./fixtures/white-house.trace.json"
import { changedIndices, emissionColor, matrixAbsMax, pieceDisplay, softmaxRow, stripBIO } from "./helpers.ts"

// Compile-time tie (type-only, erased at build): the docs mirror must accept every real trace. A
// NeuralParseTrace field rename/retype now fails HERE at typecheck instead of at runtime on /trace.
const _traceMirrorAccepts: ParseTraceLike = {} as NeuralParseTrace

void _traceMirrorAccepts

describe("ModelVisualizer helpers", () => {
	it("softmaxRow sums to 1 and preserves argmax", () => {
		const probs = softmaxRow([1, 3, 2])
		const sum = probs.reduce((a, b) => a + b, 0)

		expect(sum).toBeCloseTo(1, 6)
		expect(probs[1]).toBeGreaterThan(probs[2]!)
		expect(probs[2]).toBeGreaterThan(probs[0]!)
	})

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

	it("stripBIO drops the prefix, keeps O", () => {
		expect(stripBIO("B-house_number")).toBe("house_number")
		expect(stripBIO("I-street")).toBe("street")
		expect(stripBIO("O")).toBe("O")
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
		const trace = fixture as unknown as ParseTraceLike

		expect(trace.labels.length).toBeGreaterThan(0)
		expect(trace.logits).toHaveLength(trace.pieces.length)
		expect(trace.emissions).toHaveLength(trace.pieces.length)
		expect(trace.path).toHaveLength(trace.pieces.length)
		expect(trace.tokens).toHaveLength(trace.pieces.length)

		// The label vocabulary may prefix-extend the model's emission width (Stage-prefix rule —
		// see neural/labels.ts + assertEmissionWidth): rows are uniform and never WIDER than labels.
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
			// Self-describing axis: the trace carries the country order its logits mean — the gauge (and
			// this test) key off it rather than a hardcoded class count.
			expect(trace.localeCountries).toBeDefined()
			expect(trace.localeLogits).toHaveLength(trace.localeCountries!.length)
		}
	})
})
