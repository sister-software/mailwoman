/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution } from "../solver/Solution.js"
import { permutate } from "./permutate.js"
import { Span } from "./Span.js"
import split from "./split.js"
import * as funcs from "./split_funcs.js"

/**
 * Tokenizes a string into sections and phrases.
 */
export class Tokenizer {
	public span: Span

	/**
	 * Sections of the tokenization.
	 */
	public section: Span[]

	/**
	 * Percentage of the input text covered by the tokenization.
	 */
	public coverage = 0

	/**
	 * Solutions to the tokenization.
	 */
	public solutions: Solution[] = []

	constructor(input: string = "") {
		this.span = new Span(input)
		this.section = split(this.span, funcs.fieldsFuncBoundary)

		this.split()
		this.computeCoverage()
		this.permute(0, 10)
	}

	/**
	 * Split the tokenization into sections.
	 */
	split() {
		for (const section of this.section) {
			section.setChildren(split(section, funcs.fieldsFuncWhiteSpace))
			section.setChildren(split(section, funcs.fieldsFuncHyphenOrWhiteSpace))
		}
	}

	/**
	 * Permute the phrases of the tokenization.
	 */
	permute(windowMin: number, windowMax: number) {
		for (const section of this.section) {
			section.setPhrases(permutate(section.graph.findAll("child"), windowMin, windowMax))
		}
	}

	/**
	 * Compute the coverage of the tokenization.
	 */
	computeCoverageRec(sum: number, curr: Span | null): number {
		if (!curr) {
			return sum
		}

		return this.computeCoverageRec(sum + curr.end - curr.start, curr.graph.findOne("next"))
	}

	/**
	 * Compute the coverage of the tokenization.
	 */
	computeCoverage(): void {
		this.coverage = 0

		this.section.forEach((s) => {
			this.coverage += this.computeCoverageRec(0, s.graph.findOne("child"))
		})
	}
}
