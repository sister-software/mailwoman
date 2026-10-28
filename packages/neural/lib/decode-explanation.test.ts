/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests that the decode explanation is computed from the objective the decoder summed: the terms
 *   sum to each margin and to the decoder's own score, and the runner-up is the best reading that
 *   relabels the span.
 */

import { mulberry32 } from "@mailwoman/core/random"
import { describe, expect, it } from "vitest"

import {
	composeEmissions,
	DECODE_TERMS,
	explainDecode,
	type DecodeObjective,
	type DecodeTermValues,
} from "#decode-explanation"
import { buildBIOEndMask, buildBIOStartMask, buildBIOTransitionMask, viterbi, viterbiPathTerms } from "#viterbi"

const LABELS = ["O", "B-street", "I-street", "B-locality", "I-locality"] as const
const PIECES = ["▁12", "▁Main", "▁St", "▁Spring", "field"]
const TEXT = "12 Main St Springfield"

const pieces: Array<{ piece: string; start: number; end: number }> = []

for (const piece of PIECES) {
	const word = piece.replace("▁", "")
	const start = TEXT.indexOf(word, pieces.at(-1)?.end ?? 0)

	pieces.push({ piece, start, end: start + word.length })
}

function randomMatrix(seed: number, scale: number): number[][] {
	const random = mulberry32(seed)

	return PIECES.map(() => LABELS.map(() => (random() - 0.5) * scale))
}

function objectiveFor(seed: number, overrides: Partial<DecodeObjective> = {}): DecodeObjective {
	return {
		decode: "viterbi",
		logits: randomMatrix(seed, 6),
		emissionPriors: [
			{ term: "fst", matrix: randomMatrix(seed + 1, 2) },
			// A prior narrower than the emissions, as a stage-2 label list inside a wider vocabulary produces.
			{ term: "spanProposer", matrix: randomMatrix(seed + 2, 2).slice(0, 3) },
		],
		maskedLabels: new Set([4]),
		transitions: buildBIOTransitionMask(LABELS),
		startTransitions: buildBIOStartMask(LABELS),
		endTransitions: buildBIOEndMask(LABELS),
		transitionAdjustments: [{ timestep: 3, toLabel: 3, bonus: 0.75 }],
		...overrides,
	}
}

function decode(objective: DecodeObjective): { emissions: number[][]; path: number[]; score: number } {
	const emissions = composeEmissions(objective)

	const { path, score } = viterbi({
		emissions,
		transitions: objective.transitions,
		startTransitions: objective.startTransitions,
		endTransitions: objective.endTransitions,
		...(objective.transitionAdjustments ? { transitionAdjustments: objective.transitionAdjustments } : {}),
	})

	return { emissions, path, score }
}

function explain(objective: DecodeObjective) {
	const { emissions, path, score } = decode(objective)

	return {
		path,
		score,
		emissions,
		explanation: explainDecode({
			objective,
			emissions,
			path,
			viterbiScore: score,
			labels: LABELS,
			pieces,
			text: TEXT,
		}),
	}
}

function termTotal(values: DecodeTermValues): number {
	return DECODE_TERMS.reduce((total, term) => total + values[term], 0)
}

/**
 * Every label path over the pieces, for an exhaustive check of the runner-up search.
 */
function allPaths(length: number, width: number): number[][] {
	if (length === 0) return [[]]

	return allPaths(length - 1, width).flatMap((prefix) => Array.from({ length: width }, (_, k) => [...prefix, k]))
}

describe("explainDecode", () => {
	it.each([7, 19, 101, 4242])("sums the terms to the decoder's own score (seed %i)", (seed) => {
		const { explanation, score } = explain(objectiveFor(seed))

		expect(explanation.decoderScore).toBe(score)
		expect(termTotal(explanation.decodedTerms)).toBeCloseTo(score, 6)
	})

	it.each([7, 19, 101, 4242])("sums each span's term margins to its margin (seed %i)", (seed) => {
		const { explanation } = explain(objectiveFor(seed))

		expect(explanation.spans.length).toBeGreaterThan(0)

		for (const span of explanation.spans) {
			expect(span.termMargins).not.toBeNull()
			expect(termTotal(span.termMargins!)).toBeCloseTo(span.margin!, 6)
			expect(span.margin!).toBeGreaterThanOrEqual(0)
		}
	})

	it.each([7, 19, 101, 4242])("finds the best reading that relabels each span (seed %i)", (seed) => {
		const objective = objectiveFor(seed)
		const { explanation, path, emissions } = explain(objective)

		const scored = allPaths(PIECES.length, LABELS.length).map((candidate) => {
			const parts = viterbiPathTerms(
				{
					emissions,
					transitions: objective.transitions,
					startTransitions: objective.startTransitions,
					endTransitions: objective.endTransitions,
					transitionAdjustments: objective.transitionAdjustments!,
				},
				candidate
			)

			return { candidate, total: parts.emissions + parts.transitions + parts.adjustments }
		})

		for (const span of explanation.spans) {
			const rivals = scored.filter(({ candidate }) =>
				candidate.slice(span.pieceStart, span.pieceEnd).some((label, i) => label !== path[span.pieceStart + i])
			)

			const best = Math.max(...rivals.map((rival) => rival.total))

			expect(span.runnerUp!.total).toBeCloseTo(best, 6)
		}
	})

	it("reports the prior that changed a span and what it added to the decoded reading", () => {
		const logits = PIECES.map(() => LABELS.map(() => 0))
		logits[3] = [1, 0, 0, 0.5, 0]

		const fst = PIECES.map(() => LABELS.map(() => 0))
		fst[3] = [0, 0, 0, 1, 0]

		const objective = objectiveFor(0, {
			logits,
			emissionPriors: [{ term: "fst", matrix: fst }],
			maskedLabels: null,
			transitionAdjustments: null,
		})

		const { explanation, path } = explain(objective)

		expect(LABELS[path[3]!]).toBe("B-locality")
		const [entry] = explanation.ledger

		expect(entry).toMatchObject({
			prior: "fst",
			cells: [{ piece: 3, label: "B-locality", delta: 1 }],
			decodedPathContribution: 1,
			changes: [{ piece: 3, text: "▁Spring", from: "B-locality", to: "O" }],
		})

		expect(explanation.spans[entry!.changedSpans[0]!]!.text).toBe("Spring")

		const spring = explanation.spans.find((span) => span.text === "Spring")!

		expect(spring.runnerUp!.labels).toEqual(["O"])
		expect(spring.termMargins!.fst).toBe(1)
		expect(spring.termMargins!.logits).toBe(-0.5)
		expect(spring.margin).toBeCloseTo(0.5, 12)
	})

	it("itemizes the conventions mask and the placetype-pair transition bonus", () => {
		const objective = objectiveFor(19)
		const { explanation } = explain(objective)

		const mask = explanation.ledger.find((entry) => entry.prior === "conventionsMask")!
		const pair = explanation.ledger.find((entry) => entry.prior === "placetypePair")!

		expect(mask.cells.map((cell) => cell.label)).toEqual(PIECES.map(() => "I-locality"))
		expect(pair.transitionBonuses).toEqual([{ piece: 3, label: "B-locality", bonus: 0.75 }])
	})

	it("refuses an objective that does not reproduce the decoder's emissions", () => {
		const objective = objectiveFor(7)
		const { emissions, path, score } = decode(objective)

		expect(() =>
			explainDecode({
				objective: { ...objective, emissionPriors: objective.emissionPriors.slice(1) },
				emissions,
				path,
				viterbiScore: score,
				labels: LABELS,
				pieces,
				text: TEXT,
			})
		).toThrow(/do not reproduce the decoder's emission matrix/)
	})

	it("explains an argmax decode with zero transition terms", () => {
		const objective = objectiveFor(101, { decode: "argmax", transitionAdjustments: null })
		const emissions = composeEmissions(objective)
		const path = emissions.map((row) => row.indexOf(Math.max(...row)))

		const explanation = explainDecode({
			objective,
			emissions,
			path,
			viterbiScore: null,
			labels: LABELS,
			pieces,
			text: TEXT,
		})

		expect(explanation.decodedTerms.transitions).toBe(0)
		expect(termTotal(explanation.decodedTerms)).toBeCloseTo(explanation.decoderScore, 6)

		for (const span of explanation.spans) {
			expect(termTotal(span.termMargins!)).toBeCloseTo(span.margin!, 6)
		}
	})
})
