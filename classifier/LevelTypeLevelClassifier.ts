/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { LevelClassification } from "../classification/LevelClassification.js"
import { LevelTypeClassification } from "../classification/LevelTypeClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import { Classifier, ClassifyInput } from "./super/BaseClassifier.js"

export class LevelTypeLevelClassifier implements Classifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		libpostal.load(this.index, ["en"], "level_types_numbered.txt")
	}

	classifyTokenizer(tokenizer: Tokenizer) {
		for (let sectionIndex = 0; sectionIndex < tokenizer.section.length; sectionIndex++) {
			const children = tokenizer.section[sectionIndex]!.graph.findAll("child")

			for (let childIndex = 0; childIndex < children.length; childIndex++) {
				this.each(children[childIndex]!, tokenizer.section[sectionIndex]!)
			}
		}
	}

	classify(input: ClassifyInput): Span {
		const span = Span.from(input)

		this.each(span, span)

		return span
	}

	each(span: Span, section: Span) {
		// skip spans whithout numbers
		if (!span.contains.numerals) return

		// We a searching spans like `F12` which means `Floor 12`
		for (const token in this.index) {
			if (span.body.length < token.length) continue

			// perf: https://gist.github.com/dai-shi/4950506
			if (span.norm.substring(0, token.length) === token && /^\d+$/.test(span.norm.substring(token.length))) {
				const levelTypeBody = span.body.substring(0, token.length)
				const levelBody = span.body.substring(token.length)

				const levelType = new Span(levelTypeBody, span.start)
				const level = new Span(levelBody, span.start + levelTypeBody.length)

				// We are creating two spans `{level_type} {level}`
				levelType.classify(new LevelTypeClassification(1.0))
				levelType.graph.add("next", level)
				level.classify(new LevelClassification(1.0))
				level.graph.add("prev", levelType)

				span.graph.findAll("prev").forEach((prev) => levelType.graph.add("prev", prev))
				span.graph.findAll("next").forEach((next) => level.graph.add("next", next))

				section.graph.add("child", levelType)
				section.graph.add("child", level)

				return
			}
		}
	}
}
