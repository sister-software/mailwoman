/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"

class SubsetFilter {
	solve(tokenizer: Tokenizer) {
		for (const [i, solution] of tokenizer.solutions.entries()) {
			tokenizer.solutions = tokenizer.solutions.filter((s, j) => {
				if (j <= i) {
					return true
				}

				// do not favour solutions with lower scores (if for any reason they are not sorted)
				if (solution.score < s.score) {
					return false
				}

				// if two solutions cover the same tokens, remove the latter
				if (solution.coversSameClassification(s)) {
					return false
				}

				return true
			})
		}
	}
}

export default SubsetFilter
