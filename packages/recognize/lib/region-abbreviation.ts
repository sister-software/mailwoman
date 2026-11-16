// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The shape test for a region abbreviation such as `NY`.
 *
 *   The `structure` family reports the abbreviations of a whole text in its `regionAbbreviations` field.
 *   A caller that tests one token, with a wider letter limit than the family's, calls this function.
 */

/**
 * Options for {@link isRegionAbbreviationToken}.
 */
export interface RegionAbbreviationTokenOptions {
	/**
	 * Longest run of letters accepted.
	 *
	 * The `structure` family's own "City, ST" pattern wants exactly 2, the default.
	 * `@mailwoman/phrase-grouper` widens to 3 to admit three-letter codes such as `TWN`.
	 */
	maxLetters?: number
}

/**
 * True when a token is region-abbreviation shaped: 2 to `maxLetters` uppercase ASCII letters.
 *
 * It tests shape only and has no state table, so `SAN` and `DI` match at `maxLetters: 3`.
 * The caller applies any context that suppresses those.
 */
export function isRegionAbbreviationToken(token: string, options: RegionAbbreviationTokenOptions = {}): boolean {
	const { maxLetters = 2 } = options

	if (token.length < 2 || token.length > maxLetters) return false

	return /^[A-Z]+$/.test(token)
}
