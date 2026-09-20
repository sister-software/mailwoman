// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
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
 * Escape a string so an html sink renders it as literal text, markup included.
 */
export function escapeHTML(text: string): string {
	return text.replaceAll(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character)
}
