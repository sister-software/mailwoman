/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Formatting and whitespace helpers for strings.
 */

/**
 * Collapses every whitespace run to one space and trims. U+00A0 is whitespace to `\s`, so a no-break space collapses
 * with the rest.
 */
export function normalizeWhitespace(text: string): string {
	return text.replaceAll(/\s+/gu, " ").trim()
}

/**
 * The text with its trailing slashes removed: an origin a path can be appended to by concatenation, or a pathname with
 * a trailing slash forgiven. A loop rather than `/\/+$/u`: a regex anchored after a repeated class backtracks in time
 * quadratic in the run of slashes it is handed, and the input is configuration or a URL the browser was given.
 */
export function withoutTrailingSlashes(text: string): string {
	let end = text.length

	while (end > 0 && text[end - 1] === "/") {
		end -= 1
	}

	return text.slice(0, end)
}
