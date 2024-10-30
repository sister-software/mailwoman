/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"

const MAX_DISTANCE = 2

class TokenDistanceFilter {
	solve(tokenizer: Tokenizer) {
		tokenizer.solutions = tokenizer.solutions.filter((s) => {
			const housenumber = s.pair.filter((p) => p.classification.constructor.name === "HouseNumberClassification")
			const street = s.pair.filter((p) => p.classification.constructor.name === "StreetClassification")

			// housenumber with no street
			// note: remove this as a postcode classification may be more relevant
			// note: this functionality may no longer be valid in an autocomplete context
			if (housenumber.length > 0 && street.length === 0) {
				s.pair = s.pair.filter((p) => p.classification.constructor.name !== "HouseNumberClassification")
				return s.pair.length > 0
			}

			// both housenumber and street classified
			// ensure tokens are less than n distance apart
			if (housenumber.length > 0 && street.length > 0) {
				if (street[0]!.span.distance(housenumber[0]!.span) > MAX_DISTANCE) {
					return false
				}
			}

			return true
		})
	}
}

export default TokenDistanceFilter
