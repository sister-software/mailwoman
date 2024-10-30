/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"

class OrphanedUnitTypeDeclassifier {
	solve(tokenizer: Tokenizer) {
		tokenizer.solutions = tokenizer.solutions.filter((solutions) => {
			// only applies to solutions containing a UnitTypeClassification
			const unitType = solutions.pair.filter((p) => p.classification.constructor.name === "UnitTypeClassification")
			if (unitType.length === 0) {
				return true
			}

			// check for presence of a UnitClassification
			const unit = solutions.pair.filter((p) => p.classification.constructor.name === "UnitClassification")

			// remove UnitTypeClassification with no corresponding UnitClassification
			if (unit.length === 0) {
				solutions.pair = solutions.pair.filter((p) => p.classification.constructor.name !== "UnitTypeClassification")
				return solutions.pair.length > 0
			}

			return true
		})
	}
}

export default OrphanedUnitTypeDeclassifier
