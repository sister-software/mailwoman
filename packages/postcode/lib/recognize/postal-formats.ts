// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `knownFormats` of the `postal` generation: a hit for each postcode candidate
 *   of the `postal` family and a hit for each PO box.
 *
 *   A postcode hit holds the countries whose syntax accepts the form, the form,
 *   the locale of the most populous of those countries, and a confidence derived
 *   from the country count (see `postal-confidence.ts`).
 *   A PO box hit holds `null` for the countries, the form and the locale.
 *
 *   Every hit owns its span object.
 */

import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"
import { COUNTRY_POPULATION } from "@mailwoman/codex/country/population"
import { type CountrySet, countriesDeclaredBy, hasCountry, worldCountries } from "@mailwoman/codex/country/sets"
import { poBoxSpans } from "@mailwoman/recognize/po-box"
import type { KnownFormatHit, TokenClass } from "@mailwoman/recognize/types"

import { postcodeSyntaxCountries } from "#country-formats"
import { postalConfidence } from "#recognize/postal-confidence"
import {
	isPostalRecognition,
	type PostalForm,
	type PostalRecognitionLike,
	postalCountryCodes,
	postalSpans,
	splitPrintedPostcode,
} from "#recognize/postal/readers"

/**
 * The format name of a postcode hit of the `postal` generation.
 */
export const POSTAL_FORMAT = "postcode"

/**
 * The format name of a PO box hit.
 */
export const PO_BOX_FORMAT = "po_box"

/**
 * The confidence of a PO box hit, equal to the legacy table's value.
 */
export const PO_BOX_CONFIDENCE = 0.85

/**
 * One known-format hit of the `postal` generation.
 */
export interface PostalFormatHit extends KnownFormatHit<typeof POSTAL_FORMAT | typeof PO_BOX_FORMAT> {
	/**
	 * The countries whose syntax accepts the form, for a postcode hit, and `null` for a PO box.
	 */
	readonly countries: CountrySet | null
	/**
	 * The form of the span, for a postcode hit, and `null` for a PO box.
	 */
	readonly form: PostalForm | null
	/**
	 * The BCP 47 locale of the most populous accepting country, such as `en-GB`,
	 * for a postcode hit, and `null` for a PO box.
	 */
	readonly locale: string | null
}

const world = worldCountries()

let familySize = 0

const countryCache = new Map<string, CountrySet>()

function acceptingSet(codes: readonly string[]): CountrySet {
	const key = codes.join(",")
	let set = countryCache.get(key)

	if (!set) {
		set = countriesDeclaredBy(
			"postal family",
			codes.filter((code) => hasCountry(world, code))
		)

		countryCache.set(key, set)
	}

	return set
}

const localeCache = new Map<string, string | null>()

/**
 * The locale of the most populous country among `codes`: its first official
 * two-letter language and the country.
 *
 * A country the population table omits counts as zero, and a tie resolves to the earlier code.
 */
function localeOfMostPopulous(codes: readonly string[]): string | null {
	const key = codes.join(",")

	if (localeCache.has(key)) return localeCache.get(key)!

	let best: string | null = null

	for (const code of codes) {
		if (!hasCountry(world, code)) continue

		if (best === null || (COUNTRY_POPULATION[code] ?? 0) > (COUNTRY_POPULATION[best] ?? 0)) {
			best = code
		}
	}

	const language = best ? OFFICIAL_LANGUAGES[best]?.official.find((tag) => tag.length === 2) : undefined
	const locale = best && language ? `${language}-${best}` : null

	localeCache.set(key, locale)

	return locale
}

/**
 * The form of a hit, read from what the span holds.
 *
 * A span a printed shape matched is `designated`.
 * Any other span is `alnum` when it holds a letter, and `numeric` when it holds digits,
 * hyphens and white space only.
 *
 * The shape's own form isn't used for the rest, because a shape that allows
 * a letter also matches a digit run.
 */
function formOf(shapeForm: PostalForm, body: string): PostalForm {
	if (shapeForm === "designated") return "designated"

	return /\p{L}/u.test(body) ? "alnum" : "numeric"
}

/**
 * The known-format hits of a text: its postcode candidates and its PO boxes,
 * ordered by start and then by length, longest first.
 *
 * @param recognitions The recognitions of a recognizer that composes the `postal` family.
 * @param tokens The `tokenClasses` of the same recognizer's `structure` fields.
 */
export function postalFormatHits(
	recognitions: ReadonlyArray<PostalRecognitionLike>,
	tokens: readonly TokenClass[],
	text: string
): PostalFormatHit[] {
	familySize ||= postcodeSyntaxCountries().length

	const hits: PostalFormatHit[] = []

	// A code that a connector separates from a longer code stands no more, as `69152` in `69152-656`.
	const standing = new Set(postalSpans(recognitions, text).map((span) => `${span.start}:${span.end}`))
	const groups = new Map<string, { start: number; end: number; printed: boolean; codes: Set<string> }>()

	for (const recognition of recognitions) {
		if (!isPostalRecognition(recognition)) continue

		const printed = splitPrintedPostcode(recognition)

		const codeStart = printed
			? recognition.start + recognition.text.length - recognition.text.slice(printed.prefix.length).trimStart().length
			: recognition.start

		if (!standing.has(`${codeStart}:${recognition.end}`)) continue

		// A candidate without a digit is a word that some country's letter-only form accepts (`New York`).
		// The training encoder's anchor painter and the card's postal repair refuse it by the same rule.
		if (!/\p{Nd}/u.test(recognition.text)) continue

		// A printed candidate and a bare one on the same code are two hits: the prefix is evidence of its own.
		const key = `${recognition.start}:${recognition.end}:${printed ? "printed" : "bare"}`

		const group = groups.get(key) ?? {
			start: recognition.start,
			end: recognition.end,
			printed: Boolean(printed),
			codes: new Set<string>(),
		}

		for (const code of postalCountryCodes(recognition)) {
			group.codes.add(code)
		}

		groups.set(key, group)
	}

	for (const group of groups.values()) {
		const codes = [...group.codes].toSorted()
		const body = text.slice(group.start, group.end)
		const form = formOf(group.printed ? "designated" : "numeric", body)

		hits.push({
			format: POSTAL_FORMAT,
			span: { start: group.start, end: group.end, body },
			confidence: postalConfidence(codes.length, form, familySize),
			countries: acceptingSet(codes),
			form,
			locale: localeOfMostPopulous(codes),
		})
	}

	for (const box of poBoxSpans(tokens, text)) {
		hits.push({
			format: PO_BOX_FORMAT,
			span: box,
			confidence: PO_BOX_CONFIDENCE,
			countries: null,
			form: null,
			locale: null,
		})
	}

	return hits.toSorted((a, b) => a.span.start - b.span.start || b.span.end - a.span.end)
}
