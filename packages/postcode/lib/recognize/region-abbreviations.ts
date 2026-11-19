// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The region abbreviations of a text under the `postal` generation.
 *
 *   A region abbreviation is a token written in upper-case ASCII letters that the codex
 *   holds as the subdivision code of at least one country, in any comma segment of the text.
 *   The codex holds the subdivision codes of four countries: the United States (56 codes),
 *   Canada (13), Australia (8) and the United Kingdom (4), with 79 distinct codes
 *   among them, and `WA` and `NT` belong to two countries each.
 *   A hit lists every country that holds its code.
 *
 *   The generation drops two rules of the legacy one: the position rule
 *   (a later segment of a comma-separated text) and the shape rule (any two upper-case letters).
 *   `NW` in `Main St, NW, Washington` is no abbreviation, because no table holds it.
 */

import { type CountrySet, countriesDeclaredBy } from "@mailwoman/codex/country/sets"
import { matchSubdivisionsAnywhere } from "@mailwoman/codex/country/subdivision"
import type { TokenClass } from "@mailwoman/recognizer/types"

import type { QueryShapeRegionAbbreviation } from "#recognize/query-shape"

const SHAPE = /^[A-Z]{2,3}$/

const countryCache = new Map<string, CountrySet | null>()

/**
 * The countries whose subdivision code is `token`, or `null` when no country holds it.
 */
function countriesHolding(token: string): CountrySet | null {
	if (countryCache.has(token)) return countryCache.get(token)!

	const countries = matchSubdivisionsAnywhere(token)
		.filter((match) => match.code === token)
		.map((match) => match.country)

	const set = countries.length ? countriesDeclaredBy("subdivision codes", countries) : null

	countryCache.set(token, set)

	return set
}

/**
 * The region abbreviations among `tokens`, in order.
 *
 * Each hit owns its span object.
 */
export function regionAbbreviationsOf(tokens: readonly TokenClass[]): QueryShapeRegionAbbreviation[] {
	const found: QueryShapeRegionAbbreviation[] = []

	for (const token of tokens) {
		if (token.class !== "alpha" || !SHAPE.test(token.span.body)) continue

		const countries = countriesHolding(token.span.body)

		if (!countries) continue

		found.push({
			start: token.span.start,
			span: { start: token.span.start, end: token.span.end, body: token.span.body },
			countries,
		})
	}

	return found
}
