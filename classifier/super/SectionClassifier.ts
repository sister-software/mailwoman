/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "../../tokenization/Span.js"
import { Tokenizer } from "../../tokenization/Tokenizer.js"
import { Classifier, ClassifyInput } from "./BaseClassifier.js"

export interface SectionClassifierUtils {
	findPhrasesContaining: (child: Span) => Span[]
}

abstract class SectionClassifier implements Classifier {
	// classify an whole section

	abstract each(span: Span): void

	classifyTokenizer(tokenizer: Tokenizer) {
		for (const section of tokenizer.section) {
			this.each(section)
		}
	}

	classify(input: ClassifyInput): Span {
		const span = Span.from(input)

		this.each(span)

		return span
	}

	/**
	 * Find all phrases containing a child span.
	 */
	static findPhrasesContaining(section: Span, child: Span) {
		return section.graph.findAll("phrase").filter((p) => p.graph.some("child", (pc) => pc === child))
	}
}

export default SectionClassifier
