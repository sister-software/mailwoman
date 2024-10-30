/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"
import SolutionPair from "./SolutionPair.js"

export class Solution {
	/**
	 * Mapping of classification labels to mask codes.
	 *
	 * @type {Record<string, string>}
	 */
	static map: Record<string, string> = {
		venue: "V",
		housenumber: "N",
		street: "S",
		postcode: "P",
		level: "L",
		level_type: "L",
		unit: "U",
		unit_type: "U",
		default: "A",
	}

	public pair: SolutionPair[]

	/**
	 * Absolute score of the solution.
	 */
	public score = 0

	/**
	 * Penalty for the solution. This is used to penalize solutions that are not complete.
	 */
	public penalty = 0

	/**
	 * Create a new solution.
	 */
	constructor(pairs: SolutionPair[] = []) {
		this.pair = pairs
	}

	/**
	 * Create a deep copy of this solution.
	 */
	copy(): Solution {
		return new Solution(this.pair.slice(0))
	}

	/**
	 * Predicate to determine if this solution covers another solution, i.e. the target solution is a
	 * subset of this solution without any unique ranges.
	 */
	covers(solution: Solution): boolean {
		return solution.pair.every((p) => this.pair.some((pp) => pp.span.covers(p.span)))
	}

	/**
	 * Predicate to determine if a solution covers another solution with the same classification.
	 */
	coversSameClassification(solution: Solution): boolean {
		return solution.pair.every((p) =>
			this.pair.some((pp) => {
				return pp.classification.constructor.name === p.classification.constructor.name && pp.span.covers(p.span)
			})
		)
	}

	/**
	 * Compute the score of a solution. The score is the average confidence of the classifications
	 * multiplied by the coverage of the input.
	 */
	computeScore(tokenizer: Tokenizer) {
		// iterate pairs to compute a score
		const score = this.pair.reduce(
			(memo, cur) => {
				// use the span range if it does not have children
				let range = cur.span.end - cur.span.start

				// if it does have children, iterate them so that
				// delimiters such as spaces are not counted in the range
				if (cur.span.graph.length("child")) {
					range = cur.span.graph.findAll("child").reduce((sum, child) => {
						return sum + (child.end - child.start)
					}, 0)
				}

				// total characters covered
				memo.coverage += range

				// confidence of match multiplied by characters covered
				memo.confidence += cur.classification.confidence * range
				return memo
			},
			{ coverage: 0, confidence: 0 }
		)

		// absolute score
		// the average character score coveered divided by the total coverage
		this.score = (score.confidence / score.coverage) * (score.coverage / tokenizer.coverage) * (1.0 - this.penalty)
	}

	/**
	 * Mask which shows the areas covered by different types of classification
	 *
	 * - `N` housenumber
	 * - `S` street
	 * - `P` postcode
	 * - `A` administrative
	 * - `L` Level
	 * - `U` unit
	 *
	 * @returns Mask of the input for this solution
	 */
	mask(tokenizer: Tokenizer): string {
		// use the original input, mask should be the same length
		const body = tokenizer.span.body
		const mask = Array(body.length).fill(" ")

		// scan the input letter-by-letter from left-to-right
		for (let i = 0; i < body.length; i++) {
			// find which fields cover this character (should only be covered by 0 or 1 field)
			const coveredBy = this.pair.filter((p) => p.span.start <= i && p.span.end >= i)

			const [firstPair] = coveredBy

			if (firstPair) {
				const label = firstPair.classification.label
				const code = Object.hasOwn(Solution.map, label) ? Solution.map[label] : Solution.map.default

				for (let j = firstPair.span.start; j < firstPair.span.end; j++) {
					mask[j] = code
				}

				// skip forward to avoid scanning the same token again
				i = firstPair.span.end
			}
		}

		return mask.join("")
	}

	// @todo implement this
	// equals(solution) {}
}

export default Solution
