/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"

const NETURAL_CLASSIFICATIONS = ["PostcodeClassification"]

const ADMIN_CLASSIFICATIONS = ["LocalityClassification", "RegionClassification", "CountryClassification"]

class LeadingAreaDeclassifier {
	solve(tokenizer: Tokenizer) {
		for (const solution of tokenizer.solutions) {
			// record the position of the last non-admin cursor position
			let lastNonAdminCursorPosition = 0

			for (const solutionPair of solution.pair) {
				const isAdmin = ADMIN_CLASSIFICATIONS.some((c) => solutionPair.classification.constructor.name === c)
				const isNeut = NETURAL_CLASSIFICATIONS.some((c) => solutionPair.classification.constructor.name === c)
				if (!isAdmin && !isNeut) {
					lastNonAdminCursorPosition = solutionPair.span.end
				}
			}

			solution.pair = solution.pair.filter((p) => {
				const isAdmin = ADMIN_CLASSIFICATIONS.some((c) => p.classification.constructor.name === c)
				if (isAdmin && p.span.end < lastNonAdminCursorPosition) {
					return false
				}
				return true
			})
		}

		tokenizer.solutions.sort((a, b) => b.score - a.score) // sort results by score desc
		tokenizer.solutions.forEach((s) => s.pair.sort((a, b) => a.span.start - b.span.start)) // sort by span start
	}
}

export default LeadingAreaDeclassifier
