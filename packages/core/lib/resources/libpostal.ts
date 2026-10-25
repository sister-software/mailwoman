// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The language vocabulary libpostal's dictionaries are keyed by, and the parser for their lines.
 *
 *   The dictionary files themselves ship in `@mailwoman/dictionaries`, which also owns their readers.
 */

import { TextSpliterator } from "spliterator"

import type { Alpha2LanguageCode } from "#resources/languages/types.gen"

/**
 * A libpostal dictionary language, or `all` for the language-agnostic directory.
 */
export type LibPostalLanguageCode = Alpha2LanguageCode | "all"

/**
 * The surfaces of one dictionary line.
 * A line reads `canonical|variant|variant…`.
 */
export function libpostalLineSurfaces(line: string): string[] {
	return TextSpliterator.from(line, { delimiter: "|" }).toArray()
}
