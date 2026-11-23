// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The key a postcode-prefix index holds for a full postcode, for each country that has a rule.
 *
 *   A prefix index groups unit postcodes under a coarser code the postal authority issues:
 *   the GB outward code and the US three-digit sectional center.
 *
 *   The index build and the resolver's probe both derive the key with {@linkcode postcodePrefixAt},
 *   so a code the build grouped under a key is probed under the same key.
 *
 *   A GB outward code is the compact form minus its last three characters.
 *   A greedy `^([A-Z]{1,2}\d{1,2})` reads `EC1A1BB` as `EC1` and is wrong.
 */

/**
 * How a prefix is derived from a compact postcode.
 *
 * `"outward"` drops the three-character inward code a GB unit postcode ends in.
 * A digit string keeps that count of leading characters, as `"3"` does for a US sectional center.
 * A prefix index writes the value to its header's `levels`.
 */
export type PostcodePrefixLevel = "outward" | "3"

/**
 * The length of the inward code, the sector digit and two unit letters a GB postcode ends in.
 */
const INWARD_CODE_LENGTH = 3

/**
 * The length of the shortest compact GB unit postcode, `M11AE`.
 *
 * A shorter string has no inward code to drop.
 */
const MIN_OUTWARD_SOURCE_LENGTH = 5

/**
 * The prefix level of each country whose prefix rule is written, keyed by ISO 3166-1 alpha-2 code.
 */
export const POSTCODE_PREFIX_LEVELS = {
	GB: "outward",
	US: "3",
} as const satisfies Readonly<Record<string, PostcodePrefixLevel>>

/**
 * Returns the prefix level of a country in either case, or `null` for a country without a rule.
 */
export function postcodePrefixLevel(country: string): PostcodePrefixLevel | null {
	const code = country.toUpperCase()

	return Object.hasOwn(POSTCODE_PREFIX_LEVELS, code)
		? POSTCODE_PREFIX_LEVELS[code as keyof typeof POSTCODE_PREFIX_LEVELS]
		: null
}

/**
 * Returns the prefix of a postcode written without separators.
 *
 * @returns `null` when the code is too short to hold a prefix at that level.
 */
export function postcodePrefixAt(compact: string, level: PostcodePrefixLevel): string | null {
	if (level === "outward") {
		return compact.length >= MIN_OUTWARD_SOURCE_LENGTH ? compact.slice(0, -INWARD_CODE_LENGTH) : null
	}

	const width = Number.parseInt(level, 10)

	return compact.length >= width ? compact.slice(0, width) : null
}
