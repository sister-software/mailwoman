/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	compareMatchesByStart,
	rankingSolutionsByAreaClassification,
	SerializedSolution,
	type Solution,
} from "@mailwoman/core/solver"
import { permutate } from "./permutate.js"
import { SerializedSpan, Span } from "./Span.js"
import { fieldsFuncBoundary, fieldsFuncHyphenOrWhiteSpace, fieldsFuncWhiteSpace, splitByField } from "./split.js"

export interface SerializedTokenContext {
	span: SerializedSpan
	solutions: SerializedSolution[]
	sections: SerializedSpan[]
	readonly coverage: number
}

/**
 * Tokenizes a string into sections and phrases.
 */
export class TokenContext {
	#span!: Span
	#sections: Span[] = []
	#coverage: number = 0

	#solutions: Solution[] = []

	public get solutions(): Solution[] {
		return this.#solutions
	}

	public set solutions(nextSolutions: Solution[]) {
		// if (this.#solutions.length && nextSolutions.length < this.#solutions.length) {
		// 	console.log(`--------------------------------------`)
		// 	console.log(`${this.#solutions.length} Solution(s)`)

		// 	for (const [i, solution] of this.#solutions.entries()) {
		// 		console.log(`Solution ${i + 1}`, solution.toJSON())
		// 	}
		// }

		this.#solutions = nextSolutions
	}

	public get span(): Span {
		return this.#span
	}

	/**
	 * Sections of the tokenization.
	 */
	public get sections(): Span[] {
		return this.#sections
	}

	constructor(input: string = "") {
		this.#span = Span.from(input)

		// Split the input into sections.
		const sections = splitByField(this.#span, fieldsFuncBoundary)

		for (const section of sections) {
			// Then, split each section into phrases.
			section.children.add(...splitByField(section, fieldsFuncWhiteSpace))
			section.children.add(...splitByField(section, fieldsFuncHyphenOrWhiteSpace))
		}

		this.#sections = sections
		this.#coverage = computeCoverage(sections)

		// Permute the phrases of each section.
		for (const section of this.sections) {
			const permutations = permutate(section.children, { from: 0, to: 10 })

			section.phrases.add(...permutations)
		}
	}

	/**
	 * Evaluate and rank the solutions.
	 *
	 * This method is called after the solver has generated solutions, modifying the solutions
	 * in-place.
	 */
	public evaluateAndRank(solutionLimit: number): void {
		if (this.#solutions.length === 0) return

		for (const solution of this.#solutions) {
			// Re-compute scores.
			solution.computeScore(this.#coverage)

			// Re-sort matches.
			solution.matches.sort(compareMatchesByStart)
		}

		// Re-sort the solutions.
		this.#solutions.sort(rankingSolutionsByAreaClassification)

		// Finally, we keep only the best solutions.
		this.#solutions = this.#solutions.slice(0, solutionLimit)
	}

	/**
	 * Serialize the tokenizer.
	 */
	public toJSON(): SerializedTokenContext {
		return {
			span: this.span.toJSON(),
			sections: this.sections.map((s) => s.toJSON()),
			solutions: this.#solutions.map((s) => s.toJSON()),
			coverage: this.#coverage,
		}
	}
}

/**
 * Compute the coverage of the tokenization.
 */
function computeCoverageRec(sum: number, currentSpan: Span | null): number {
	if (!currentSpan) return sum

	sum += currentSpan.end - currentSpan.start

	if (currentSpan.end < currentSpan.start) {
		throw new Error(`Tokenizer: invalid span ${currentSpan.start} ${currentSpan.end}`)
	}

	return computeCoverageRec(sum, currentSpan.nextSibling)
}

/**
 * Compute the coverage of the tokenization.
 */
function computeCoverage(sections: Span[]): number {
	let coverage = 0

	for (const [i, section] of sections.entries()) {
		const firstChild = section.children.first

		if (!firstChild) throw new Error(`Tokenizer: section ${i} has no children`)

		coverage += computeCoverageRec(0, firstChild)
	}

	return coverage
}
