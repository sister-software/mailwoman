/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"

class InvalidSolutionFilter {
	patterns: string[][]

	constructor(patterns: string | string[][]) {
		this.patterns = Array.isArray(patterns) ? patterns : []

		this.patterns.map((p) => p.sort()) // sort alphabetically
	}

	solve(tokenizer: Tokenizer) {
		tokenizer.solutions = tokenizer.solutions.filter((solution) => {
			// sort alphabetically
			const classifications = solution.pair.map((p) => p.classification.constructor.name).sort()

			return !this.patterns.some((p) => {
				if (classifications.length !== p.length) {
					return false
				}

				return classifications.every((_, i) => classifications[i] === p[i])
			})
		})
	}
}

export default InvalidSolutionFilter
