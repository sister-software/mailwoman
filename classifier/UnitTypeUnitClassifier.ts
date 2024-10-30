/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { UnitClassification } from "../classification/UnitClassification.js"
import { UnitTypeClassification } from "../classification/UnitTypeClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import { Classifier, ClassifyInput } from "./super/BaseClassifier.js"

export class UnitTypeUnitClassifier implements Classifier {
	public index: Record<string | number, any> = {}

	constructor() {
		libpostal.load(this.index, ["en"], "unit_types_numbered.txt")
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

		// We a searching spans like `U12` which means `Unit 12`
		for (const token in this.index) {
			if (span.body.length < token.length) continue

			// perf: https://gist.github.com/dai-shi/4950506
			if (span.norm.substring(0, token.length) === token && /^\d+$/.test(span.norm.substring(token.length))) {
				const unitTypeBody = span.body.substring(0, token.length)
				const unitBody = span.body.substring(token.length)

				const unitType = new Span(unitTypeBody, span.start)
				const unit = new Span(unitBody, span.start + unitTypeBody.length)

				// We are creating two spans `{unit_type} {unit}`
				unitType.classify(new UnitTypeClassification(1.0))
				unitType.graph.add("next", unit)
				unit.classify(new UnitClassification(1.0))
				unit.graph.add("prev", unitType)

				span.graph.findAll("prev").forEach((prev) => unitType.graph.add("prev", prev))
				span.graph.findAll("next").forEach((next) => unit.graph.add("next", next))

				section.graph.add("child", unitType)
				section.graph.add("child", unit)

				return
			}
		}
	}
}
