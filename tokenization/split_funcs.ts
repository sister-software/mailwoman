/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

const whitespace = /^\s$/
const quotes = '"«»‘’‚‛“”„‟‹›⹂「」『』〝〞〟﹁﹂﹃﹄＂＇｢｣'

/**
 * Predicate to test if a character is a field boundary
 */
export function fieldsFuncBoundary(char: string): boolean {
	switch (char) {
		case "\n":
			return true
		case "\t":
			return true
		case ",":
			return true
		default:
			// @todo: this should ideally only work for 'matching pairs' of quotes
			if (quotes.includes(char)) {
				return true
			}

			return false
	}
}

// test for any unicode whitespace char including newlines and tabs
// @todo: is this possible in js without using a regex?
/**
 * Predicate to test if a character is a field whitespace.
 */
export function fieldsFuncWhiteSpace(char: string): boolean {
	return whitespace.test(char)
}

/**
 * Predicate to test if a character is a hyphen or whitespace.
 */
export function fieldsFuncHyphenOrWhiteSpace(char: string): boolean {
	return char === "-" || char === "/" || fieldsFuncWhiteSpace(char)
}
