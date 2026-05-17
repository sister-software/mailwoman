/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "./Span.js"

type FieldMatchPredicate = (char: string) => boolean

export function splitByField(span: Span, predicate: FieldMatchPredicate): Span[] {
	// A span is used to record a slice of s of the form s[start:end].
	// The start index is inclusive and the end index is exclusive.
	const spans: Span[] = []

	// Find the field start and end indices.
	let wasField = false
	let fromIndex = 0

	// Iterate unicode code points in string
	for (let i = 0; i < span.body.length; i++) {
		const char = span.body.charAt(i)

		if (predicate(char)) {
			if (wasField) {
				let appendedChild = Iterator.from(span.children).find((child) => {
					return child.start === span.start + fromIndex && child.body === span.body.substring(fromIndex, i)
				})

				appendedChild ||= Span.from(span.body.substring(fromIndex, i), {
					start: span.start + fromIndex,
				})

				spans.push(appendedChild)

				wasField = false
			}
		} else if (!wasField) {
			fromIndex = i
			wasField = true
		}
	}

	// Last field might end at EOF.
	if (wasField) {
		spans.push(
			Iterator.from(span.children).find(
				(s) => s.start === span.start + fromIndex && s.body === span.body.substring(fromIndex, span.body.length)
			) || Span.from(span.body.substring(fromIndex, span.body.length), { start: span.start + fromIndex })
		)
	}

	// Add siblings to graph
	Span.connectSiblings(...spans)

	return spans
}

const quotes = '"«»‘’‚‛“”„‟‹›⹂「」『』〝〞〟﹁﹂﹃﹄＂＇｢｣'
const fieldBoundaryPattern = /\n|\t|,/

/**
 * Predicate to test if a character is a field boundary
 */
export const fieldsFuncBoundary: FieldMatchPredicate = (char) => {
	// TODO: this should ideally only work for 'matching pairs' of quotes.
	return fieldBoundaryPattern.test(char) || quotes.includes(char)
}

/**
 * Predicate to test if a character is a field whitespace.
 */
export const fieldsFuncWhiteSpace: FieldMatchPredicate = (char) => {
	return char.trim().length === 0
}

/**
 * Predicate to test if a character is a hyphen or whitespace.
 */
export const fieldsFuncHyphenOrWhiteSpace: FieldMatchPredicate = (char) => {
	return char === "-" || char === "/" || fieldsFuncWhiteSpace(char)
}
