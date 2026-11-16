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
import { postalConfidence } from "#recognize/postal/confidence"
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

/**
 * What a set of accepting countries holds for a hit.
 */
interface AcceptedCountries {
	readonly count: number
	readonly set: CountrySet
	readonly locale: string | null
}

/**
 * The accepting countries of a shape, keyed by the shape's own list.
 * The metadata returns that list by reference.
 */
const singleCache = new WeakMap<readonly string[], AcceptedCountries>()

/**
 * The accepting countries of several shapes, by the sorted union of their codes.
 */
const unionCache = new Map<string, AcceptedCountries>()

function describeCountries(codes: readonly string[]): AcceptedCountries {
	return {
		count: codes.length,
		set: countriesDeclaredBy(
			"postal family",
			codes.filter((code) => hasCountry(world, code))
		),
		locale: localeOfMostPopulous(codes),
	}
}

/**
 * The accepting countries of the lists of one hit.
 *
 * The common case, one shape, reads the cache by the list itself and copies no list.
 */
function acceptedCountries(lists: ReadonlyArray<readonly string[]>): AcceptedCountries {
	if (lists.length === 1) {
		const list = lists[0]!
		let known = singleCache.get(list)

		if (!known) {
			known = describeCountries(list)
			singleCache.set(list, known)
		}

		return known
	}

	const codes = [...new Set(lists.flat())].toSorted()
	const key = codes.join(",")
	let known = unionCache.get(key)

	if (!known) {
		known = describeCountries(codes)
		unionCache.set(key, known)
	}

	return known
}

/**
 * The locale of the most populous country among `codes`: its first official
 * two-letter language and the country.
 *
 * A country the population table omits counts as zero, and a tie resolves to the earlier code.
 */
function localeOfMostPopulous(codes: readonly string[]): string | null {
	let best: string | null = null

	for (const code of codes) {
		if (!hasCountry(world, code)) continue

		if (best === null || (COUNTRY_POPULATION[code] ?? 0) > (COUNTRY_POPULATION[best] ?? 0)) {
			best = code
		}
	}

	const language = best ? OFFICIAL_LANGUAGES[best]?.official.find((tag) => tag.length === 2) : undefined

	return best && language ? `${language}-${best}` : null
}

/**
 * The fewest digits a bare run of digits, hyphens and white space needs to stand as a postcode.
 *
 * A run of four digits or fewer can be a house number, a year or a count, and it can be a code.
 * `MAX_UNAMBIGUOUS_HOUSE_NUMBER_DIGITS` of `@mailwoman/phrase-grouper` states the same limit,
 * and the legacy table reported no bare run of fewer than five digits.
 */
const MIN_BARE_DIGITS = 5

/**
 * Whether a bare candidate reads as ordinary address text, so it stands as no postcode evidence.
 *
 * Three shapes do.
 * A run of at most four digits is a house number or a year (`MIN_BARE_DIGITS`).
 *
 * A word of letters followed by a space and a number (`Lot 19`, `Qld 4069`) is the form of a few
 * countries' codes and the form of a street unit or a state and a code in addresses of other countries.
 * A candidate with a separate word of three letters or more (`77A Neil`) holds a name.
 * The legacy table reported none of the three.
 *
 * A form that mixes letters and digits in one word (`SW1A 1AA`, `K1A 0B1`, `1012AB`) and a digit run
 * followed by letters (`1012 AB`) are no ordinary text, and a printed prefix is evidence of its own.
 */
function readsAsOrdinaryText(body: string): boolean {
	if (!/\p{L}/u.test(body)) return (body.match(/\p{Nd}/gu) ?? []).length < MIN_BARE_DIGITS

	return /^\p{L}{2,}\s+\p{Nd}/u.test(body) || body.split(/\s+/u).some((word) => /^\p{L}{3,}$/u.test(word))
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

	const groups = new Map<
		string,
		{
			start: number
			end: number
			printed: boolean
			codeStart: number
			/**
			 * The country list of each recognition in the group, in ISO order.
			 */
			lists: Array<readonly string[]>
		}
	>()

	for (const recognition of recognitions) {
		if (!isPostalRecognition(recognition)) continue

		// A candidate without a digit is a word that some country's letter-only form accepts (`New York`).
		// The training encoder's anchor painter and the card's postal repair refuse it by the same rule.
		if (!/\p{Nd}/u.test(recognition.text)) continue

		const printed = splitPrintedPostcode(recognition)

		if (!printed && readsAsOrdinaryText(recognition.text)) continue

		// A printed candidate and a bare one on the same code are two hits: the prefix is evidence of its own.
		const key = `${recognition.start}:${recognition.end}:${printed ? "printed" : "bare"}`

		const group = groups.get(key) ?? {
			start: recognition.start,
			end: recognition.end,
			printed: Boolean(printed),
			codeStart: printed
				? recognition.start + recognition.text.length - recognition.text.slice(printed.prefix.length).trimStart().length
				: recognition.start,
			lists: [],
		}

		group.lists.push(postalCountryCodes(recognition))
		groups.set(key, group)
	}

	if (!groups.size) return finish(hits, tokens, text)

	// A code that a connector separates from a longer code stands no more, as `69152` in `69152-656`.
	const standing = new Set(postalSpans(recognitions, text).map((span) => `${span.start}:${span.end}`))
	const printedGroups = [...groups.values()].filter((group) => group.printed)

	for (const group of groups.values()) {
		if (!standing.has(`${group.codeStart}:${group.end}`)) continue

		// A bare code that a printed hit contains adds no evidence: the prefix already marks it as a postcode.
		if (!group.printed && printedGroups.some((printed) => printed.start <= group.start && group.end === printed.end))
			continue

		const body = text.slice(group.start, group.end)
		const form = formOf(group.printed ? "designated" : "numeric", body)
		const accepted = acceptedCountries(group.lists)

		hits.push({
			format: POSTAL_FORMAT,
			span: { start: group.start, end: group.end, body },
			confidence: postalConfidence(accepted.count, form, familySize),
			countries: accepted.set,
			form,
			locale: accepted.locale,
		})
	}

	return finish(hits, tokens, text)
}

/**
 * Adds the PO boxes to the hits and orders them by start, then by length, longest first.
 */
function finish(hits: PostalFormatHit[], tokens: readonly TokenClass[], text: string): PostalFormatHit[] {
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
