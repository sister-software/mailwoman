/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classifier } from "../classifier/super/BaseClassifier.js"
import { Solution } from "../solver/Solution.js"
import { Solver } from "../solver/super/BaseSolver.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"

export interface ParserOptions {
	max_solutions: number
}

/**
 * Parses a tokenized address into a structured address.
 */
class Parser {
	public classifiers: Classifier[]
	public solvers: Solver[]
	public options: ParserOptions

	constructor(classifiers: Classifier[], solvers: Solver[], options: Partial<ParserOptions> = {}) {
		this.classifiers = classifiers
		this.solvers = solvers

		this.options = {
			max_solutions: 10,
			...options,
		}
	}

	/**
	 * Run all classifiers.
	 */
	classify(tokenizer: Tokenizer): void {
		this.classifiers.forEach((c) => c.classifyTokenizer(tokenizer))
	}

	/**
	 * Run all solvers.
	 */
	solve(tokenizer: Tokenizer): void {
		for (const solver of this.solvers) {
			this.scoreAndSort(tokenizer)

			// run solver
			solver.solve(tokenizer)
		}

		this.scoreAndSort(tokenizer)
	}

	/**
	 * Score and sort solutions.
	 */
	scoreAndSort(tokenizer: Tokenizer) {
		// recompute scores
		tokenizer.solutions.forEach((s) => s.computeScore(tokenizer))

		// sort pairs by span start
		tokenizer.solutions.forEach((s) => s.pair.sort((a, b) => a.span.start - b.span.start))

		// sort results by score desc
		tokenizer.solutions.sort(this.comparitor)

		// ensure that no more than $MAX_SOLUTIONS are retained
		if (tokenizer.solutions.length > this.options.max_solutions) {
			tokenizer.solutions = tokenizer.solutions.slice(0, this.options.max_solutions)
		}
	}

	// @todo: possibly move the admin penalty scoring to another file
	/**
	 * Compare solutions for sorting
	 */
	comparitor(a: Solution, b: Solution): number {
		// if scores are equal then enforce a slight penalty for administrative ordering
		if (b.score === a.score) {
			const areas = {
				a: a.pair.filter((p) => {
					return Object.hasOwn(p.span.classifications, "AreaClassification")
				}),
				b: b.pair.filter((p) => {
					return Object.hasOwn(p.span.classifications, "AreaClassification")
				}),
			}

			const classification = {
				a: areas.a.length ? areas.a[0]?.classification.constructor.name : "",
				b: areas.b.length ? areas.b[0]?.classification.constructor.name : "",
			}

			if (classification.a === "LocalityClassification") {
				return -1
			}

			if (classification.b === "LocalityClassification") {
				return 1
			}

			if (classification.a === "RegionClassification") {
				return -1
			}

			if (classification.b === "RegionClassification") {
				return 1
			}

			if (classification.a === "CountryClassification") {
				return -1
			}

			if (classification.b === "CountryClassification") {
				return 1
			}
		}

		// sort results by score desc
		return b.score - a.score
	}
}

export default Parser
