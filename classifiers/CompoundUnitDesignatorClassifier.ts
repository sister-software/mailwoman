/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	Alpha2LanguageCode,
	type Classifier,
	type ClassifierOptions,
	type LibPostalLanguageCode,
	LocaleIndex,
	prepareLocaleIndex,
	Span,
	TokenContext,
} from "@mailwoman/core"

export class CompoundUnitDesignatorClassifier implements Classifier {
	public index!: LocaleIndex<LibPostalLanguageCode>
	protected languages?: LibPostalLanguageCode[]

	constructor({ languages }: ClassifierOptions = {}) {
		this.languages = languages ? Array.from(languages) : undefined
	}

	public async ready(): Promise<this> {
		const languages = this.languages ?? [Alpha2LanguageCode.English]
		this.index = await prepareLocaleIndex(languages, "unit_types_numbered.txt")

		return this
	}

	public classifyTokens(context: TokenContext): void {
		for (const section of context.sections) {
			for (const child of section.children) {
				this.explore(child, section)
			}
		}
	}

	public classify(input: Span | string): Span {
		const span = Span.from(input)

		this.explore(span, span)

		return span
	}

	public explore(span: Span, section: Span): void {
		if (!span.flags.has("alphanumeric")) return

		// We a searching spans like `U12` which means `Unit 12`
		for (const token of this.index.keys()) {
			if (span.body.length < token.length) continue

			if (
				span.normalized.substring(0, token.length) === token &&
				/^\d+$/.test(span.normalized.substring(token.length))
			) {
				const unitTypeBody = span.body.substring(0, token.length)
				const unitBody = span.body.substring(token.length)

				const unitType = Span.from(unitTypeBody, { start: span.start })
				const unit = Span.from(unitBody, { start: span.start + unitTypeBody.length })

				// We are creating two spans `{unit_type} {unit}`
				unitType.classifications.add("unit_designator")
				unitType.nextSiblings.add(unit)

				unit.classifications.add("unit")
				unit.previousSiblings.add(unitType)

				span.previousSiblings.forEach((prev) => unitType.previousSiblings.add(prev))
				span.nextSiblings.forEach((next) => unit.nextSiblings.add(next))

				section.children.add(unitType)
				section.children.add(unit)

				return
			}
		}
	}
}
