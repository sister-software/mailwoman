/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { StreetLocale } from "#street/normalize"

/**
 * The widest span of numbers a written range covers on one building or block.
 */
const WIDEST_HOUSE_NUMBER_RANGE = 200

/**
 * Returns whether two hyphenated numbers read as one number rather than a range of houses.
 *
 * `8-9 Upper St` is a range, and joining it would answer the different house at number 89.
 * `19-4074` and Queens's `123-45` cannot be ranges, because a range climbs by a short step.
 */
function isJoinedHyphenNumber(number: string): boolean {
	const parts = /^(\d+)-(\d+)$/.exec(number)

	if (!parts) return false

	const span = Number(parts[2]) - Number(parts[1])

	return span < 0 || span > WIDEST_HOUSE_NUMBER_RANGE
}

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
 *
 * Both address readers call this, so they try one number in one order.
 */
export function* houseNumberForms(number: string, locale: StreetLocale): Generator<string> {
	yield number

	if (isJoinedHyphenNumber(number)) {
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

	if (locale === "zh") {
		const base = /^(\d+)(?:[之附]\d+)+$/u.exec(number)?.[1]

		if (base) {
			yield base
		}
	}
}
