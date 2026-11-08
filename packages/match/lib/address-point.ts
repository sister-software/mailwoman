// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Comparisons for two address points that share a street: the unit each states and the house number each states.
 *
 *   A unit's identifier is read by the caller, since designator words are per-country (`UNIT 2`, `Apt. 2` and `#2`
 *   all identify `2` under USPS Publication 28). The comparisons here only compare what the extractor returns.
 */

import type { Comparison, ComparisonLevel } from "#fellegi-sunter"

/**
 * A unit as one record states it: the text as written and its identifier with the designator removed.
 */
export interface UnitValue {
	raw: string | null
	identifier: string | null
}

/**
 * Seed levels for {@link unitComparison}, best agreement first.
 * EM re-estimates `m` and `u` from the data.
 */
export const DEFAULT_UNIT_LEVELS: ComparisonLevel[] = [
	{ label: "same-text", m: 0.55, u: 0.05 },
	{ label: "same-identifier", m: 0.1, u: 0.01 },
	{ label: "neither-states", m: 0.25, u: 0.3 },
	{ label: "one-states", m: 0.08, u: 0.24 },
	{ label: "different", m: 0.02, u: 0.4 },
]

/**
 * Compares the units two records state.
 *
 * The levels are: the same text, the same identifier written differently, neither record
 * stating a unit, one record stating a unit and the other none, and different identifiers.
 * Two records without a unit agree that each is a whole building or a single door,
 * so that outcome is a level of its own rather than missing evidence.
 */
export function unitComparison<R>(config: {
	name?: string
	extract: (record: R) => UnitValue
	levels?: ComparisonLevel[]
}): Comparison<R> {
	return {
		name: config.name ?? "unit",
		levels: config.levels ?? DEFAULT_UNIT_LEVELS,
		assess(a, b) {
			const ua = config.extract(a)
			const ub = config.extract(b)
			const hasA = ua.identifier != null
			const hasB = ub.identifier != null

			if (!hasA && !hasB) return 2

			if (hasA !== hasB) return 3

			if (ua.raw === ub.raw) return 0

			return ua.identifier === ub.identifier ? 1 : 4
		},
	}
}

/**
 * A house number read into its integer base, its suffix and the end of a range it spans,
 * or `null` when no digits lead it.
 */
export interface HouseNumberParts {
	base: number
	suffix: string
	rangeEnd: number | null
}

const HOUSE_NUMBER = /^\s*(\d+)\s*([A-Za-z]{0,2}|\s*\d+\/\d+)?\s*(?:-\s*(\d+))?\s*$/

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
export function isJoinedHouseNumber(number: string): boolean {
	const parts = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(number)

	if (!parts) return false

	const span = Number(parts[2]) - Number(parts[1])

	return span < 0 || span > WIDEST_HOUSE_NUMBER_RANGE
}

/**
 * Reads a house number such as `12`, `12A`, `12 1/2` or `12-14` into its parts,
 * or `null` when it does not start with digits.
 *
 * A hyphenated number that {@link isJoinedHouseNumber} reads as one number,
 * such as Hawaii's `19-4074`, is read as its joined digits, `194074`, with no range.
 */
export function houseNumberParts(value: string | null | undefined): HouseNumberParts | null {
	if (value != null && isJoinedHouseNumber(value)) {
		return { base: Number(value.replaceAll(/[\s-]/g, "")), suffix: "", rangeEnd: null }
	}

	const match = value == null ? null : HOUSE_NUMBER.exec(value)

	if (!match) return null

	const rangeEnd = match[3] == null ? null : Number(match[3])

	return {
		base: Number(match[1]),
		suffix: (match[2] ?? "").replaceAll(/\s+/g, "").toUpperCase(),
		rangeEnd: rangeEnd != null && rangeEnd > Number(match[1]) ? rangeEnd : null,
	}
}

/**
 * Seed levels for {@link houseNumberComparison}, best agreement first.
 */
export const DEFAULT_HOUSE_NUMBER_LEVELS: ComparisonLevel[] = [
	{ label: "exact", m: 0.9, u: 0.02 },
	{ label: "same-base", m: 0.05, u: 0.01 },
	{ label: "in-range", m: 0.03, u: 0.01 },
	{ label: "different", m: 0.02, u: 0.96 },
]

/**
 * Compares the house numbers two records state.
 *
 * The levels are: the same number, the same integer base with a different suffix (`12` against `12A`),
 * one number inside the other's range (`12` against `12-14`), and different numbers.
 * A number without leading digits on either side is compared as text, exact
 * or different, and an absent number is missing evidence.
 */
export function houseNumberComparison<R>(config: {
	name?: string
	extract: (record: R) => string | null | undefined
	levels?: ComparisonLevel[]
}): Comparison<R> {
	return {
		name: config.name ?? "house-number",
		levels: config.levels ?? DEFAULT_HOUSE_NUMBER_LEVELS,
		assess(a, b) {
			const na = config.extract(a)?.trim()
			const nb = config.extract(b)?.trim()

			if (!na || !nb) return -1

			if (na.toUpperCase() === nb.toUpperCase()) return 0

			const pa = houseNumberParts(na)
			const pb = houseNumberParts(nb)

			if (!pa || !pb) return 3

			if (pa.base === pb.base && pa.rangeEnd == null && pb.rangeEnd == null) return pa.suffix === pb.suffix ? 0 : 1

			const inside = (point: HouseNumberParts, range: HouseNumberParts) =>
				range.rangeEnd != null && point.base >= range.base && point.base <= range.rangeEnd

			return inside(pa, pb) || inside(pb, pa) ? 2 : 3
		},
	}
}
