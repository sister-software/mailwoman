/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	countBatchTransitions,
	emptyTransitionCounts,
	fitTransitions,
	scaleTransitions,
} from "#tools/training/fit/transitions"

const LABELS = ["O", "B-street", "I-street"]

describe("countBatchTransitions", () => {
	it("counts adjacent labeled positions and skips ignored ones", () => {
		const counts = emptyTransitionCounts(LABELS)
		// Row 0: [ignore, B, I, ignore, O]; row 1: [O, B, ignore, ignore, ignore].
		const labels = BigInt64Array.from([-100, 1, 2, -100, 0, 0, 1, -100, -100, -100].map(BigInt))

		countBatchTransitions(counts, labels, 2, 5, -100)

		expect(counts.rows).toBe(2)
		expect(counts.starts).toEqual([1, 1, 0])
		expect(counts.ends).toEqual([1, 1, 0])

		expect(counts.transitions).toEqual([
			[0, 1, 0],
			[0, 0, 1],
			[1, 0, 0],
		])
	})

	it("refuses a label id outside the label list", () => {
		const counts = emptyTransitionCounts(LABELS)

		expect(() => countBatchTransitions(counts, BigInt64Array.from([3n]), 1, 1, -100)).toThrow(/outside the 3 labels/)
	})
})

describe("fitTransitions", () => {
	it("gives each row's most frequent successor 0 and the others a negative potential", () => {
		const counts = emptyTransitionCounts(LABELS)

		countBatchTransitions(counts, BigInt64Array.from([1, 2, 2, 0].map(BigInt)), 1, 4, -100)

		const fitted = fitTransitions(counts)

		// B-street is followed by I-street once: (1 + 1) / 4 against (0 + 1) / 4.
		expect(fitted.transitions[1]).toEqual([Math.log(1 / 2), Math.log(1 / 2), 0])
		expect(fitted.start_transitions[1]).toBe(0)
		expect(Math.max(...fitted.transitions[2]!)).toBe(0)

		const scaled = scaleTransitions(fitted, 2)

		expect(scaled.transitions[1]![0]).toBeCloseTo(2 * Math.log(1 / 2))
	})
})
