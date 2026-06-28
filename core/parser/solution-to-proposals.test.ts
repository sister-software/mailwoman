/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `solutionToProposals` (#478 inc 3) — projects a solved v0 solution's matches into rule proposals,
 *   dropping matches whose legacy classification has no `ComponentTag` mapping.
 */

import { describe, expect, it } from "vitest"

import type { SerializedSolution } from "../solver/index.js"
import { solutionToProposals } from "./solution-to-proposals.js"

function match(classification: string, value: string, start: number, confidence: number) {
	return { classification, value, start, end: start + value.length, confidence }
}

function solution(matches: ReturnType<typeof match>[]): SerializedSolution {
	return { score: 1, penalty: 0, classifications: {}, formatted_address: "", matches } as unknown as SerializedSolution
}

describe("solutionToProposals", () => {
	it("projects mapped matches into rule proposals, skipping unmapped legacy tags", () => {
		const props = solutionToProposals(
			solution([
				match("house_number", "350", 0, 0.9),
				match("street", "Main St", 4, 0.8),
				match("stop_word", "of", 12, 0.5), // unmapped → dropped
			]),
			"v0"
		)
		expect(props.map((p) => p.component)).toEqual(["house_number", "street"])
		expect(props.every((p) => p.source === "rule" && p.source_id === "v0")).toBe(true)
		expect(props[0]).toMatchObject({ confidence: 0.9 })
		expect(props[0]!.span.start).toBe(0)
		expect(props[0]!.span.end).toBe(3)
	})

	it("defaults source_id to 'rule' and returns [] for an empty solution", () => {
		expect(solutionToProposals(solution([]))).toEqual([])
		const [p] = solutionToProposals(solution([match("country", "US", 0, 1)]))
		expect(p?.source_id).toBe("rule")
	})
})
