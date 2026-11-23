// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Moves a repetition index (`bis`, `ter`, `quater`) from the start of a split street
 *   onto the house number it follows, in a country that writes one.
 *
 *   {@linkcode splitStreetLine} splits `20 BIS RUE LOUIS PHILIPPE` into `20` and `BIS RUE LOUIS PHILIPPE`.
 *   The BAN adapter, reading the same address from BAN's own columns,
 *   labels `20 bis` as the house number and `RUE LOUIS PHILIPPE` as the street,
 *   and this module gives a one-line source that labeling.
 *
 *   The words and the countries come from `@mailwoman/codex/labels/house-number/repetition`.
 *
 *   It runs after the shared split rather than inside it.
 *   The split's other callers read no country, and they keep their output.
 */

import { houseNumberRepetitionIndexes } from "@mailwoman/codex/labels/house-number/repetition"

import type { SplitStreetLine } from "#adapters/street/line"

const patternMemo = new Map<string, { spaced: RegExp; joined: RegExp; trailing: RegExp } | null>()

function patternsFor(country: string): { spaced: RegExp; joined: RegExp; trailing: RegExp } | null {
	const key = country.toUpperCase()

	if (patternMemo.has(key)) return patternMemo.get(key)!

	const words = houseNumberRepetitionIndexes(key)
	const alternation = words.join("|")

	const patterns = words.length
		? {
				// The index opening the street, then the street name: `BIS RUE LOUIS PHILIPPE`.
				spaced: new RegExp(`^(${alternation})(?![\\p{L}])[\\s,]+(\\S.*)$`, "iu"),
				// A number with the index written against it, then the street: `20BIS RUE LOUIS PHILIPPE`.
				joined: new RegExp(`^(\\d+(?: ?- ?\\d+)?(?:${alternation}))\\s+(\\S.*)$`, "iu"),
				// A house number that ends in the index: `20 BIS`, `20BIS`.
				trailing: new RegExp(`^(\\d.*?)\\s*(?:${alternation})$`, "iu"),
			}
		: null

	patternMemo.set(key, patterns)

	return patterns
}

/**
 * The split with a leading repetition index moved onto the house number,
 * in a country that writes one, or the split unchanged.
 *
 * The index keeps the publisher's spelling, so `26 Bis Boulevard Princesse Charlotte`
 * yields `26 Bis`, and is joined with a space as BAN joins `numero` and `rep`.
 * A number written against its index, `20BIS RUE X`, which the shared split
 * leaves whole, yields `20BIS` and `RUE X`.
 */
export function joinRepetitionIndex(split: SplitStreetLine, country: string): SplitStreetLine {
	const patterns = patternsFor(country)

	if (!patterns) return split

	if (split.house_number) {
		// Only a bare number or range takes an index, so `20A` keeps the street it was split from.
		if (!/^\d+(?: ?- ?\d+)?$/u.test(split.house_number)) return split

		const match = patterns.spaced.exec(split.street)

		return match ? { house_number: `${split.house_number} ${match[1]}`, street: match[2]!.trim() } : split
	}

	const match = patterns.joined.exec(split.street)

	return match ? { house_number: match[1]!, street: match[2]!.trim() } : split
}

/**
 * The house number without a trailing repetition index, or `null` when it ends in none.
 *
 * A publisher's separate number column may state `20` where the street line writes `20 BIS`,
 * and a caller checking the two against each other compares the number this returns.
 */
export function withoutRepetitionIndex(houseNumber: string, country: string): string | null {
	const match = patternsFor(country)?.trailing.exec(houseNumber.trim())

	return match ? match[1]! : null
}
