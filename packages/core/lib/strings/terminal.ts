// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Text a terminal program wrote, as plain text.
 */

/**
 * An ANSI control sequence: ESC, `[`, its numeric parameters, and the letter that ends it, such as `ESC[31m`.
 *
 * The pattern is built from the code point so the source holds no literal control character.
 */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu")

/**
 * `text` with its ANSI control sequences removed, such as the color codes Chalk and Vitest write.
 */
export function stripANSI(text: string): string {
	return text.replaceAll(ANSI_SEQUENCE, "")
}
