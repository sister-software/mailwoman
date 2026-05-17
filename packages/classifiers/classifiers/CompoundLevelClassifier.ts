/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	Alpha2LanguageCode,
	Classifier,
	ClassifierOptions,
	LibPostalLanguageCode,
	LocaleIndex,
	prepareLocaleIndex,
	Span,
	TokenContext,
} from "@mailwoman/core"

export class CompoundLevelClassifier implements Classifier {
	public index!: LocaleIndex<LibPostalLanguageCode>
	protected languages?: LibPostalLanguageCode[]

	constructor({ languages }: ClassifierOptions = {}) {
		this.languages = languages ? Array.from(languages) : undefined
	}

	public async ready(): Promise<this> {
		const languages = this.languages ?? [Alpha2LanguageCode.English]
		this.index = await prepareLocaleIndex(languages, "level_types_numbered.txt")

		return this
	}

	public classifyTokens(context: TokenContext): void {
		for (let sectionIndex = 0; sectionIndex < context.sections.length; sectionIndex++) {
			const { children } = context.sections[sectionIndex]!

			for (const child of children) {
				this.explore(child, context.sections[sectionIndex]!)
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

		// We a searching spans like `F12` which means `Floor 12`
		for (const token of this.index.keys()) {
			if (span.body.length < token.length) continue

			if (
				span.normalized.substring(0, token.length) === token &&
				/^\d+$/.test(span.normalized.substring(token.length))
			) {
				const levelTypeBody = span.body.substring(0, token.length)
				const levelBody = span.body.substring(token.length)

				const levelType = Span.from(levelTypeBody, { start: span.start })
				const level = Span.from(levelBody, { start: span.start + levelTypeBody.length })

				// We are creating two spans `{level_type} {level}`
				levelType.classifications.add("level_designator")
				levelType.nextSiblings.add(level)

				level.classifications.add("level")
				level.previousSiblings.add(levelType)

				span.previousSiblings.forEach((previousSibling) => levelType.previousSiblings.add(previousSibling))
				span.nextSiblings.forEach((nextSibling) => level.nextSiblings.add(nextSibling))

				section.children.add(levelType)
				section.children.add(level)

				return
			}
		}
	}
}
