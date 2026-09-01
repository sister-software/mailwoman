/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Markup escaping.
 */

/**
 * The character escapes that render markup as literal text.
 */
const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
}

/**
 * Escape a string so an HTML sink renders it as literal text, markup included.
 */
export function escapeHTML(text: string): string {
	return text.replaceAll(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character)
}
