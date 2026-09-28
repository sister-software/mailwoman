/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Formatting and whitespace helpers for strings.
 */

/**
 * Collapses every whitespace run to one space and trims.
 *
 * U+00A0 is whitespace to `\s`, so a no-break space collapses with the rest.
 */
export function normalizeWhitespace(text: string): string {
	return text.replaceAll(/\s+/gu, " ").trim()
}

/**
 * Removes trailing slashes from a text value.
 *
 * The result can be an origin for path concatenation or a pathname without a trailing slash.
 *
 * The loop avoids `/\/+$/u`.
 * A regex anchored after a repeated class backtracks quadratically in the run of slashes.
 *
 * The input comes from configuration or a URL the browser was given.
 */
export function withoutTrailingSlashes(text: string): string {
	let end = text.length

	while (end > 0 && text[end - 1] === "/") {
		end -= 1
	}

	return text.slice(0, end)
}
