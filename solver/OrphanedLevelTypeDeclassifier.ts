/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"

export class OrphanedLevelTypeDeclassifier {
	solve(tokenizer: Tokenizer) {
		tokenizer.solutions = tokenizer.solutions.filter((solutions) => {
			// only applies to solutions containing a LevelTypeClassification
			const levelType = solutions.pair.filter((p) => p.classification.constructor.name === "LevelTypeClassification")
			if (levelType.length === 0) {
				return true
			}

			// check for presence of a LevelClassification
			const level = solutions.pair.filter((p) => p.classification.constructor.name === "LevelClassification")

			// remove LevelTypeClassification with no corresponding LevelClassification
			if (level.length === 0) {
				solutions.pair = solutions.pair.filter((p) => p.classification.constructor.name !== "LevelTypeClassification")
				return solutions.pair.length > 0
			}

			return true
		})
	}
}
