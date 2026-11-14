// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   ISO 639 language subtags, read from the language subtags of the IANA Language Subtag Registry.
 *
 *   The registry holds one subtag per language: the ISO 639-1 two-letter code
 *   where one exists, and otherwise the ISO 639-2, 639-3 or 639-5 three-letter code.
 *   Japanese is `ja` and never `jpn`; Cantonese is `yue`.
 */

import { languageSubtagRows } from "#artifacts/bcp47/language"
import { lazySubtagIndex } from "#bcp47/subtag-index"
import { type Parsed, ParseFailure } from "#errors"
import type { BCP47 } from "#types"

const index = lazySubtagIndex(languageSubtagRows)

const CANONICAL = /^[a-z]{2,3}$/
const LETTERS = /^[A-Za-z]{2,3}$/

/**
 * One language as the registry describes it.
 */
export interface LanguageRecord {
	subtag: BCP47.LanguageSubtag
	/**
	 * The registry's first description, such as `Japanese`.
	 */
	name: string
	descriptions: readonly string[]
	/**
	 * The script a tag for this language leaves implied, such as `Jpan` for `ja`, or `null`.
	 */
	suppressScript: string | null
	/**
	 * The macrolanguage this language is a member of, such as `zh` for `yue`, or `null`.
	 */
	macrolanguage: string | null
	/**
	 * `macrolanguage`, `collection`, `special` or `private-use`, or `null` for an individual language.
	 */
	scope: string | null
	deprecated: string | null
	preferredValue: string | null
}

/**
 * Whether `input` is a language subtag the registry holds, in lowercase.
 */
export function isLanguageSubtag(input: string): input is BCP47.LanguageSubtag {
	return CANONICAL.test(input) && index().get(input) !== null
}

/**
 * The branded language subtag, or the reason the input was refused.
 */
export function parseLanguageSubtag(input: string): Parsed<BCP47.LanguageSubtag> {
	if (!LETTERS.test(input)) return { ok: false, reason: ParseFailure.Shape, input }

	if (!CANONICAL.test(input)) return { ok: false, reason: ParseFailure.Case, input }

	if (!isLanguageSubtag(input)) return { ok: false, reason: ParseFailure.NotFound, input }

	return { ok: true, value: input }
}

/**
 * The record of a lowercase language subtag, or `null`.
 */
export function getLanguage(subtag: string): LanguageRecord | null {
	if (!CANONICAL.test(subtag)) return null

	const row = index().get(subtag)

	if (!row) return null

	return {
		subtag: subtag as BCP47.LanguageSubtag,
		name: row.descriptions[0] ?? subtag,
		descriptions: row.descriptions,
		suppressScript: row.suppressScript ?? null,
		macrolanguage: row.macrolanguage ?? null,
		scope: row.scope ?? null,
		deprecated: row.deprecated ?? null,
		preferredValue: row.preferredValue ?? null,
	}
}
