// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Readers of the `postal` family's recognitions: the countries a recognition's syntax
 *   accepts, the whole-input form of `countriesAcceptingPostcode`, the embedded candidates
 *   of an address, and the separation of a printed prefix from its code.
 *
 *   # Syntax only
 *
 *   A recognition of the `postal` family reports that a string has the form of
 *   a postcode in the countries listed.
 *   It leaves open whether the code is allocated, and it doesn't consult the PCB1 or PFX1 dictionaries.
 *
 *   A candidate is evidence for the encoder to weigh, and a candidate never decides a reading.
 *
 *   # The boundary rule for an embedded candidate
 *
 *   The structure tokenizer keeps letters, digits and connectors together in one token,
 *   and `tolerateSpacing` lets a code hold white space between its parts.
 *   A postcode inside an address is therefore a whole run of such characters,
 *   or two of them with white space between.
 *
 *   A candidate stands when the character before it and the character
 *   after it are not an ASCII letter, an ASCII digit or a connector
 *   (the hyphen-minus, the apostrophe, the low line and the two curly single quotation marks),
 *   and the start and the end of the text count as boundaries.
 *   White space, a comma, any other punctuation and a character of another script all
 *   bound a candidate, so `100-0001` stands inside `〒100-0001東京都`.
 *
 *   The engine applies the rule: every shape of the family declares `boundary: "token"`,
 *   which the artifact stores, and the engine drops a match such as `2345` inside `123456`.
 *   The recognizer's recognitions are the candidates, and `12345 Main Street` reports
 *   its five-digit candidate with every country that writes five digits.
 */

import { type CountrySet, countriesDeclaredBy, hasCountry, worldCountries } from "@mailwoman/codex/country/sets"

import { type PostalKind, PostalMetadata } from "#recognize/postal.generated"

/**
 * What the readers need of a recognition: its kind and its span.
 */
export interface PostalRecognitionLike {
	readonly kind: string
	readonly family: string
	readonly start: number
	readonly end: number
	readonly text: string
}

/**
 * What the readers need of a recognizer.
 */
export interface PostalRecognizerLike {
	recognize(text: string): { readonly recognitions: ReadonlyArray<PostalRecognitionLike> }
}

interface ShapeMetadata {
	readonly kind: "code" | "printed"
	readonly countries: readonly string[]
	readonly prefix?: string
	readonly bare?: string
}

const SHAPES: Readonly<Record<string, ShapeMetadata>> = PostalMetadata.shapes

const world = worldCountries()

/**
 * Whether a recognition belongs to the `postal` family.
 */
export function isPostalRecognition(recognition: PostalRecognitionLike): recognition is PostalRecognitionLike & {
	readonly kind: PostalKind
} {
	return recognition.kind in SHAPES
}

/**
 * The countries whose postcode syntax accepts a recognition of the `postal` family.
 *
 * Syntax only: the set reports that the string has the form of a postcode in these
 * countries, and leaves open whether the code exists.
 * For a bare shape it is every country whose body has that language, as listed in the shape's
 * metadata, and for a printed shape it is the countries whose layout prints that prefix.
 *
 * @throws When the recognition isn't of the `postal` family.
 */
export function postalCountries(recognition: { readonly kind: string }): CountrySet {
	return countriesDeclaredBy(
		"postal family",
		postalCountryCodes(recognition).filter((code) => hasCountry(world, code))
	)
}

/**
 * Every country code whose syntax accepts a recognition of the `postal` family, in ISO order.
 *
 * It holds the codes {@link postalCountries} leaves out: libaddressinput states a
 * postcode for Ascension Island (`AC`), Tristan da Cunha (`TA`) and Kosovo (`XK`),
 * and the codex's country sets hold ISO 3166-1 alpha-2 codes only.
 *
 * @throws When the recognition isn't of the `postal` family.
 */
export function postalCountryCodes(recognition: { readonly kind: string }): readonly string[] {
	const shape = SHAPES[recognition.kind]

	if (!shape) throw new TypeError(`${recognition.kind} is not a kind of the postal family`)

	return shape.countries
}

/**
 * The text without the JavaScript white space `String.prototype.trim` removes.
 *
 * `acceptPostcode` removes the same white space before it reads a value.
 */
function trimmed(text: string): string {
	return text.trim()
}

/**
 * Every country whose postcode syntax accepts the whole of `text`, in ISO 3166-1 alpha-2 order.
 *
 * The answer equals `countriesAcceptingPostcode(text)` from `country-formats.ts`.
 * It trims the text as `acceptPostcode` does, recognizes it with the recognizer's `postal`
 * family, and unites the countries of each recognition that spans all of it.
 */
export function acceptingCountries(recognizer: PostalRecognizerLike, text: string): string[] {
	const value = trimmed(text)

	if (!value) return []

	const found = new Set<string>()

	for (const recognition of recognizer.recognize(value).recognitions) {
		if (!isPostalRecognition(recognition) || recognition.start !== 0 || recognition.end !== value.length) continue

		for (const country of postalCountryCodes(recognition)) {
			found.add(country)
		}
	}

	return [...found].toSorted()
}

/**
 * A printed postcode split into the prefix the layout prints and the code after it.
 */
export interface PrintedPostcode {
	/**
	 * The prefix as written in the text, such as `L-` or `〒`.
	 */
	readonly prefix: string
	/**
	 * The code after the prefix and any white space.
	 */
	readonly code: string
	/**
	 * The ID of the bare shape of the same code.
	 */
	readonly bare: string
}

/**
 * Splits a recognition of a printed shape into its prefix and its code.
 *
 * Returns null for a bare shape, because it has no prefix.
 * The prefix has the length of the layout's prefix, because each prefix character
 * is matched by one UTF-16 code unit.
 */
export function splitPrintedPostcode(recognition: PostalRecognitionLike): PrintedPostcode | null {
	const shape = SHAPES[recognition.kind]

	if (shape?.kind !== "printed" || !shape.prefix || !shape.bare) return null

	return {
		prefix: recognition.text.slice(0, shape.prefix.length),
		code: recognition.text.slice(shape.prefix.length).trim(),
		bare: shape.bare,
	}
}

/**
 * One postcode candidate inside a text.
 */
export interface PostalCandidate {
	readonly kind: PostalKind
	readonly start: number
	readonly end: number
	readonly text: string
	readonly countries: CountrySet
	/**
	 * The prefix and the code, for a candidate of a printed shape.
	 */
	readonly printed: PrintedPostcode | null
}

/**
 * The postcode candidates among `recognitions`, in their order.
 *
 * `recognitions` is the `recognitions` of a recognizer's result.
 * The engine has already applied the boundary rule, so a recognition of the `postal`
 * family is a candidate, and a recognition of another family is left out.
 * A candidate that spans the whole text is included.
 */
export function postalCandidates(recognitions: ReadonlyArray<PostalRecognitionLike>): PostalCandidate[] {
	const candidates: PostalCandidate[] = []

	for (const recognition of recognitions) {
		if (!isPostalRecognition(recognition)) continue

		candidates.push({
			kind: recognition.kind,
			start: recognition.start,
			end: recognition.end,
			text: recognition.text,
			countries: postalCountries(recognition),
			printed: splitPrintedPostcode(recognition),
		})
	}

	return candidates
}
