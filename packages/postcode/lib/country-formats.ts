// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Whether a whole string is a postcode in one country's format.
 *
 *   `./shapes.ts` finds postcode-shaped spans in a line without knowing the country.
 *   This module answers the narrower question an adapter asks once it holds a country's
 *   postcode value: does the value have that country's form?
 *
 *   Argentina's `C1425ABC`, Brunei's `BS8811` and Chile's seven digits are postcodes there,
 *   and a four-digit value in a six-digit country isn't.
 *
 *   The `postal` family's artifact answers: it holds the form of every country libaddressinput states,
 *   generated from `./country-formats/data.ts` and `./country-formats/written-forms.ts`.
 *   A form accepts any case and any run of white space, including none, where the stated form has a space.
 *
 *   Case folding is Unicode simple case folding, so the Kelvin sign U+212A
 *   and the long s U+017F match `k` and `s`.
 *   A printed prefix is matched by the characters whose upper case is the prefix character, so a
 *   character whose upper case is longer than itself, such as the ligature `ﬁ`, is no prefix character.
 *
 *   The engine loads on the first call.
 */

import { createRecognizer } from "@mailwoman/recognize"

import { COUNTRY_POSTCODE_FORMAT_SOURCES, type PostcodeLocalityPlacement } from "#country-formats/data"
import {
	acceptingCountries,
	isPostalRecognition,
	postal,
	postalCountryCodes,
	splitPrintedPostcode,
} from "#recognize/postal"

const recognizer = createRecognizer([postal])

/**
 * Whether libaddressinput states a postcode syntax for `countryCode`.
 *
 * It is false for a country the dataset records no postcode system for, as for the United Arab Emirates.
 */
export function statesPostcodeSyntax(countryCode: string): boolean {
	return Object.hasOwn(COUNTRY_POSTCODE_FORMAT_SOURCES, countryCode.toUpperCase())
}

/**
 * The literal `countryCode`'s layout prints immediately before the postcode, such as `MD-`,
 * or null when it prints none or the dataset states no postcode for the country.
 */
export function postcodePrefix(countryCode: string): string | null {
	return COUNTRY_POSTCODE_FORMAT_SOURCES[countryCode.toUpperCase()]?.prefix ?? null
}

/**
 * Whether `countryCode`'s layout prints the postcode before or after the locality,
 * as libaddressinput's `fmt` states it.
 *
 * Null when the dataset states no postcode for the country, or when its layout prints
 * only one of the two fields, as Japan's and Singapore's do.
 * A caller that needs an order treats null as "unknown" rather than picking one.
 */
export function postcodePlacement(countryCode: string): PostcodeLocalityPlacement | null {
	return COUNTRY_POSTCODE_FORMAT_SOURCES[countryCode.toUpperCase()]?.postcodePlacement ?? null
}

/**
 * Every country whose stated postcode format the whole of `value` matches, in ISO 3166-1 alpha-2 order.
 *
 * A bare five-digit value may match multiple countries, while `SW1A 1AA` matches only GB.
 * The list's size measures the shape's ambiguity.
 */
export function countriesAcceptingPostcode(value: string): string[] {
	return acceptingCountries(recognizer, value)
}

/**
 * Every country whose postcode format libaddressinput states, in ISO 3166-1 alpha-2 order.
 */
export function postcodeSyntaxCountries(): string[] {
	return Object.keys(COUNTRY_POSTCODE_FORMAT_SOURCES).toSorted()
}

/**
 * Whether the whole of `text`, as written, has the form of a bare postcode of `countryCode`.
 *
 * The text isn't trimmed and no printed prefix is removed, so `MD-2001` is no bare Moldovan code.
 * The answer is false for a country with no stated format.
 */
export function hasPostcodeForm(text: string, countryCode: string): boolean {
	const code = countryCode.toUpperCase()

	return recognizer
		.recognize(text)
		.recognitions.some(
			(recognition) =>
				isPostalRecognition(recognition) &&
				recognition.start === 0 &&
				recognition.end === text.length &&
				splitPrintedPostcode(recognition) === null &&
				postalCountryCodes(recognition).includes(code)
		)
}

/**
 * The postcode in `value` when the whole value has `countryCode`'s form, else null.
 *
 * The country-code prefix the layout prints (`MD-` in `MD-2001`) is removed from the value,
 * because the layout prints it again around the postcode component.
 * The value is otherwise returned as written, trimmed.
 *
 * For a country with no stated format the answer is always null.
 */
export function acceptPostcode(value: string, countryCode: string): string | null {
	const code = countryCode.toUpperCase()
	const trimmed = value.trim()

	if (!trimmed) return null

	let bare = false

	for (const recognition of recognizer.recognize(trimmed).recognitions) {
		if (
			!isPostalRecognition(recognition) ||
			recognition.start !== 0 ||
			recognition.end !== trimmed.length ||
			!postalCountryCodes(recognition).includes(code)
		) {
			continue
		}

		const printed = splitPrintedPostcode(recognition)

		if (printed) return printed.code

		bare = true
	}

	return bare ? trimmed : null
}
