/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import StreetProperNameClassification from "../classification/StreetProperNameClassification.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

/**
 * Special handling of streets with no suffix
 *
 * See: https://github.com/pelias/parser/issues/140
 */

class StreetProperNameClassifier extends WordClassifier {
	public index: {
		[key: string]: boolean
	} = {
		broadway: true,
		esplanade: true,
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// classify tokens in the index as 'street_proper_name'
		if (this.index[span.norm] === true) {
			span.classify(new StreetProperNameClassification(0.7))
		}
	}
}

export default StreetProperNameClassifier
