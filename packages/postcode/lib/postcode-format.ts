// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Which countries a postcode's format is consistent with.
 *
 * The `postal` family owns the syntax of 181 countries, and this module asks
 * which countries accept a whole string.
 * What belongs here is the policy on top of it: which forms are distinctive enough across
 * all jurisdictions to stand as country evidence, and in which calling context.
 *
 * That split matters because the two questions have different answers.
 * Codex's `candidateSystemsForPostcode` asks which of its ten address systems accept a string,
 * so a shape unique among those ten still reveals little about the other 240 jurisdictions.
 *
 * The tables below are a narrower claim, each entry verified as non-overlapping,
 * and they stay narrow deliberately.
 *
 * `@mailwoman/resolver` runs in the browser through the demo cascade, so this module
 * derives the implied country set rather than relying on a CLI caller to pass it in.
 * Codex is pure data and adds no platform dependency.
 *
 * `geocode-core` re-exports these functions for its consumers and tests.
 */

import { createRecognizer } from "@mailwoman/recognizer"

import { postal } from "#recognize/postal.generated"
import { acceptingCountries } from "#recognize/postal/readers"

const recognizer = createRecognizer([postal])

/**
 * The countries whose postcode syntax accepts the whole of `postcode`, read from the `postal` family.
 */
function acceptedBy(postcode: string): readonly string[] {
	return acceptingCountries(recognizer, postcode)
}

/**
 * The countries whose forms identify a country unambiguously, in the order they're tried.
 *
 * They're a stronger signal than the language-based coarse placer.
 * That placer conflates GB and US and routes some GB addresses to US namesakes.
 * Letters-first formats never match a US ZIP.
 *
 * Extend this list only with a country whose form is verified as non-overlapping across
 * jurisdictions, rather than as unique among the address systems codex happens to implement.
 *
 * NL's `\d{4} [A-Z]{2}` is deliberately absent: a US house number plus a directional
 * fragment (`1234 NE`) matches it exactly, and this list feeds `recognizeBarePostcode`,
 * which must never read a street name as a postcode.
 * NL appears in {@linkcode countriesFromPostcodeFormat} instead.
 *
 * - GB `E4 9AZ`: letters-first, ending `\d[A-Z]{2}`, never a US ZIP, NL, FR or CA code.
 *   Belfast `BT1 5GS` stays GB, because Northern Ireland uses GB postcodes.
 * - CA `K2P 1L4`: `A#A #A#`, ending `\d[A-Z]\d`, distinct from GB's `\d[A-Z]{2}`.
 * - IE Eircode `D02 AF30`: a routing key plus a 4-alphanumeric unique part.
 *   The unique part separates it from GB.
 */
// country-branch: GB, CA and IE were chosen by hand in the frozen table as forms no other country writes.
// The planetary source is the count of countries that accept each country's
// bare shape, from the postal family.
const SINGLE_COUNTRY_FORMS: readonly string[] = ["GB", "CA", "IE"]

/**
 * The country a parsed postcode's format implies, or null.
 */
export function countryFromPostcodeFormat(postcode: string | null | undefined): string | null {
	const p = postcode?.trim()

	if (!p) return null

	const accepted = acceptedBy(p)

	return SINGLE_COUNTRY_FORMS.find((country) => accepted.includes(country)) ?? null
}

/**
 * The countries that write spaced `NNN NN`: CZ and SK, and SE and GR beside them.
 *
 * Unlike the forms in {@linkcode SINGLE_COUNTRY_FORMS}, it implies a set,
 * so it can check a locale-inferred scope and cannot identify one country.
 */
const SHARED_NNN_NN: readonly string[] = ["CZ", "SK", "SE", "GR"]

/**
 * Returns each country consistent with the parsed postcode format.
 *
 * The function checks the single-country shapes, then the NL PC6 shape, then the shared `NNN NN` family.
 *
 * It returns an empty list when the shape implies no country, such as a bare
 * five-digit format that US, FR, DE and others share.
 * Such an input stays with the locale prior on purpose.
 *
 * Unlike {@linkcode countryFromPostcodeFormat} this isn't an unforgeable-in-any-context
 * claim, so a consumer applies it only to a tree that's a bare postcode, where the
 * street-fragment collision the single-country list must exclude cannot arise.
 */
export function countriesFromPostcodeFormat(postcode: string | null | undefined): readonly string[] {
	const p = postcode?.trim()

	if (!p) return []

	const single = countryFromPostcodeFormat(p)

	if (single) return [single]

	const accepted = acceptedBy(p)

	// NL PC6 `1012 LG`: digits first, then two letters.
	// It is too forgeable for the single-country list.
	if (accepted.includes("NL")) return ["NL"]

	// The spaced form only: the unspaced `NNNNN` is every five-digit country's, and implies none.
	if (p.includes(" ") && SHARED_NNN_NN.every((country) => accepted.includes(country))) return [...SHARED_NNN_NN]

	return []
}
