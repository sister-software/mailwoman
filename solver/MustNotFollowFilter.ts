/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"

class MustNotFollowFilter {
	public classification: { object: string; subject: string }

	constructor(objectClassification: string, subjectClassification: string) {
		this.classification = {
			object: objectClassification,
			subject: subjectClassification,
		}
	}

	solve(tokenizer: Tokenizer) {
		tokenizer.solutions = tokenizer.solutions.filter((s) => {
			const object = s.pair.filter((p) => p.classification.constructor.name === this.classification.object)
			const subject = s.pair.filter((p) => p.classification.constructor.name === this.classification.subject)

			// solution contains both object & subject classifications
			if (object.length > 0 && subject.length > 0) {
				// the object comes before the subject(s)
				if (subject.some((p) => p.span.start < object[0]!.span.end)) {
					// remove the object classification from this solution
					s.pair = s.pair.filter((p) => p.classification.constructor.name !== this.classification.object)
					return s.pair.length > 0
				}
			}

			return true
		})
	}
}

export default MustNotFollowFilter
