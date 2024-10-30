/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import HouseNumberClassification from "../classification/HouseNumberClassification.js"
import PostcodeClassification from "../classification/PostcodeClassification.js"
import StreetClassification from "../classification/StreetClassification.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import { Solver } from "./super/BaseSolver.js"

const basePenalty = 0.1

/**
 * PostcodePositionPenalty applies a penalty to solutions where the postcode may have recieved a
 * high score but doesn't commonly occur in this pattern.
 *
 * Eg. rua godinho de faria 1200
 */

class PostcodePositionPenalty implements Solver {
	solve(tokenizer: Tokenizer) {
		tokenizer.solutions.forEach((s) => {
			// Do nothing if the solution doesn't have a postcode classification
			const postcode = s.pair.find((p) => p.classification.constructor === PostcodeClassification)
			if (!postcode) {
				return
			}

			// Do nothing if the solution has a housenumber classification
			const housenumber = s.pair.find((p) => p.classification.constructor === HouseNumberClassification)
			if (housenumber) {
				return
			}

			// Do nothing for solutions with either none or 2+ street classifications (intersections)
			const streetCount = s.pair.filter((p) => p.classification.constructor === StreetClassification).length
			if (streetCount === 0 || streetCount >= 2) {
				return
			}

			// apply a small penalty
			s.penalty += basePenalty
		})
	}
}

export default PostcodePositionPenalty
