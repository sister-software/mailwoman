/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "../classification/Classification.js"
import { Span } from "../tokenization/Span.js"

class SolutionPair {
	public span: Span
	public classification: Classification

	constructor(span: Span, classification: Classification) {
		this.span = span
		this.classification = classification
	}

	/**
	 * Compare two SolutionPairs.
	 */
	equals(pair: SolutionPair) {
		return this.span === pair.span && this.classification.equals(pair.classification)
	}
}

export default SolutionPair
