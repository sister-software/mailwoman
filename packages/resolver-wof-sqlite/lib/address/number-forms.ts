// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { isJoinedHouseNumber } from "@mailwoman/match/address-point"

import { streetKeyRulesOf, type StreetLocale } from "#labels/street/normalize"

/**
 * The forms a normalized house number is probed under, the written form first,
 * each later form tried only after every earlier one missed.
 *
 * - A hyphenated number that cannot be a range is joined: Hawaii's `19-4074`
 *   is stored as `194074` by some sources.
 *   This runs ahead of the range form, because that form reads it as house number 19.
 * - A grid number leads with a compass letter, and one writer's `n3971` is another source's `n 3971`.
 * - A range such as `385-387` falls back to its low end, since a register stores one number per point.
 * - A number with one letter retries the other spacing, then the bare number:
 *   BAN stores `3 a`, while G-NAF and most OpenAddresses sources store `3a`.
 * - Under `zh`, `14之12` and `30附40` fall back to `14` and `30`, the number the Taiwanese register stores.
 *   That answer is approximate.
 * - Under a locale with repetition indexes (`fr`), `3bis`, `3 bis`, `3 b`
 *   and `3b` are one number: the spaced word, the joined word, the spaced letter
 *   and the joined letter are tried, then the bare number.
 *   BAN stores `3 bis` across most of France and `3 b` in Paris.
 *   The bare number is an approximate answer.
 *
 * Both address readers call this, so they try one number in one order.
 */
export function* houseNumberForms(number: string, locale: StreetLocale): Generator<string> {
	yield number

	const indexes = streetKeyRulesOf(locale).houseNumberRepetition
	const repetition = indexes ? repetitionForms(number, indexes) : null

	if (repetition) {
		for (const form of repetition) {
			if (form !== number) {
				yield form
			}
		}

		return
	}

	if (isJoinedHouseNumber(number)) {
		yield number.replace("-", "")
	}

	const grid = /^([nesw])(?:\s+)?(\d+)$/.exec(number)

	if (grid) {
		yield number.includes(" ") ? `${grid[1]}${grid[2]}` : `${grid[1]} ${grid[2]}`
	}

	const low = /^(\d+[a-z]?)-\d+[a-z]?$/.exec(number)?.[1]

	if (low) {
		yield low
	}

	const joined = /^(\d+)\s+([a-z])$/.exec(number)
	const spaced = /^(\d+)([a-z])$/.exec(number)

	if (joined) {
		yield `${joined[1]}${joined[2]}`
		yield joined[1]!
	} else if (spaced) {
		yield `${spaced[1]} ${spaced[2]}`
		yield spaced[1]!
	}

	const base = streetKeyRulesOf(locale).houseNumberBase?.exec(number)?.[1]

	if (base) {
		yield base
	}
}

/**
 * The spellings of a number written with a repetition index, in probe order,
 * or `null` when the number ends in no index.
 *
 * An index is written as its word or its first letter, spaced or joined.
 */
function repetitionForms(number: string, indexes: readonly string[]): string[] | null {
	const match = /^(\d+)\s*([a-z]+)$/.exec(number)
	const digits = match?.[1]
	const suffix = match?.[2]

	if (!digits || !suffix) return null

	const word = indexes.find((index) => index === suffix || index[0] === suffix)

	if (!word) return null

	return [`${digits} ${word}`, `${digits}${word}`, `${digits} ${word[0]}`, `${digits}${word[0]}`, digits]
}
