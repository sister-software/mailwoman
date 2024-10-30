/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import HouseNumberClassification from "../classification/HouseNumberClassification.js"
import StreetClassification from "../classification/StreetClassification.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import { Solver } from "./super/BaseSolver.js"

const basePenalty = 0.05
// https://github.com/pelias/api/blob/master/middleware/localNamingConventions.js
const numberLastLangs = new Map<string, number>([
	["de", basePenalty],
	["sl", basePenalty],
	["pl", basePenalty],
	["bs", basePenalty],
	["hr", basePenalty],
	["nl", basePenalty],
	["cs", basePenalty],
	["da", basePenalty],
	// Guatemala & Honduras do not flip their house numbers
	["es", basePenalty / 2],
	["fi", basePenalty],
	["el", basePenalty],
	["is", basePenalty],
	["it", basePenalty],
	["nb", basePenalty],
	["pt", basePenalty],
	["sv", basePenalty],
	["sk", basePenalty],
	["tr", basePenalty],
	["ro", basePenalty],
	["hu", basePenalty],
])

// const numberFirstLangs = {
// 	en: basePenalty,
// 	fr: basePenalty / 2, // Switzerland and Andorre has some french streets
// }

const numberFirstLangs = new Map<string, number>([
	["en", basePenalty],
	["fr", basePenalty / 2], // Switzerland and Andorre has some french streets
])

class HouseNumberPositionPenalty implements Solver {
	solve(tokenizer: Tokenizer) {
		tokenizer.solutions.forEach((s) => {
			const housenumber = s.pair.find((p) => p.classification.constructor === HouseNumberClassification)
			const street = s.pair.find((p) => p.classification.constructor === StreetClassification)

			// Do nothing if there is no street/housenumber or no meta in street classification
			if (!housenumber || !street || !street.classification.meta || !street.classification.meta.langs) {
				return
			}

			const langs = Object.keys(street.classification.meta.langs)

			// For now, we don't supports multi-lang entries
			if (langs.length !== 1 || langs[0] === "all") {
				return
			}

			const lang = langs[0]!
			const numberLastLangMatch = numberLastLangs.get(lang)
			const numberFirstMatch = numberFirstLangs.get(lang)

			// Check if the number should be in last position (after street) or first position (before street)
			if (numberLastLangMatch && housenumber.span.start < street.span.start) {
				s.penalty += numberLastLangMatch
			} else if (numberFirstMatch && street.span.start < housenumber.span.start) {
				s.penalty += numberFirstMatch
			}
		})
	}
}

export default HouseNumberPositionPenalty
