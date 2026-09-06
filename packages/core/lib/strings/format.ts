// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Formatting and whitespace helpers for strings.
 */

/**
 * Collapses every whitespace run to one space and trims. U+00A0 is whitespace to `\s`, so a no-break space collapses
 * with the rest.
 */
export function normalizeWhitespace(text: string): string {
	return text.replaceAll(/\s+/gu, " ").trim()
}
