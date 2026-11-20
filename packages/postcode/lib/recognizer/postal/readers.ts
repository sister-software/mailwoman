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
 *   A candidate stands when the character before it and the character after it are not an
 *   ASCII letter or an ASCII digit, and the start and the end of the text count as boundaries.
 *   A connector (the hyphen-minus, the apostrophe, the low line and the two curly single quotation marks)
 *   may touch a candidate, because addresses write a postcode after a hyphen
 *   (`Lahore-54000`, `FI-FI-01730`) and the old shape table matched those with `\b`.
 *
 *   White space, a comma, any other punctuation and a character of another script all
 *   bound a candidate, so `100-0001` stands inside `〒100-0001東京都`.
 *
 *   The engine applies the rule: every shape of the family declares `boundary: "alnum"`,
 *   which the artifact stores, and the engine drops a match such as `2345` inside `123456`.
 *   The recognizer's recognitions are the candidates, and `12345 Main Street` reports
 *   its five-digit candidate with every country that writes five digits.
 *
 *   The public module is `@mailwoman/postcode/recognizer/postal`, which exports
 *   these readers beside the family.
 */

import { type CountrySet, countriesDeclaredBy, hasCountry, worldCountries } from "@mailwoman/codex/country/sets"

import { type PostalKind, PostalMetadata } from "#recognizer/postal.generated"

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

/**
 * What a span of a shape may do.
 *
 * - `designated`: a printed form, with a prefix the layout prints before the code (`〒100-0001`, `L-1234`).
 *   The prefix is evidence that the code is a postcode, so a match may overwrite any existing label.
 * - `alnum`: a bare form whose language holds a letter (`SW1A 1AA`, `K1A 0B1`).
 *   A match may add a postcode when the model emitted none.
 * - `numeric`: a bare form of digits, hyphens and white space.
 *   A numeric match may only snap an existing postcode, because a digit run can be a house number.
 */
export type PostalForm = "alnum" | "numeric" | "designated"

interface ShapeMetadata {
	readonly kind: "code" | "printed"
	readonly form: PostalForm
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
 * The shapes of the `postal` family that stand for one country.
 */
export interface PostalKindsOfCountry {
	/**
	 * The bare shape of the country's code.
	 */
	readonly bare: PostalKind
	/**
	 * The shape of the code as the country's layout prints it with its prefix,
	 * or null when the layout prints none.
	 */
	readonly printed: PostalKind | null
}

let kindsByCountry: ReadonlyMap<string, PostalKindsOfCountry> | null = null

/**
 * The bare shape and the printed shape of `country`'s postcode, or null
 * when libaddressinput states no syntax for it.
 *
 * `country` is an ISO 3166-1 alpha-2 code in upper case.
 */
export function postalKindsOfCountry(country: string): PostalKindsOfCountry | null {
	if (!kindsByCountry) {
		const bare = new Map<string, PostalKind>()
		const printed = new Map<string, PostalKind>()

		for (const [kind, shape] of Object.entries(SHAPES)) {
			for (const code of shape.countries) {
				;(shape.kind === "code" ? bare : printed).set(code, kind as PostalKind)
			}
		}

		kindsByCountry = new Map(
			[...bare].map(([code, kind]) => [code, { bare: kind, printed: printed.get(code) ?? null }] as const)
		)
	}

	return kindsByCountry.get(country) ?? null
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

/**
 * One postcode span of a line: the code the anchor looks up and the form that decides what it may do.
 */
export interface PostalSpan {
	readonly kind: PostalKind
	readonly form: PostalForm
	/**
	 * UTF-16 offsets of the code.
	 *
	 * A printed shape's span starts after its prefix and the white space that follows it.
	 */
	readonly start: number
	readonly end: number
	/**
	 * The countries whose syntax a shape matching this range belongs to, in ISO order.
	 *
	 * A reader that looks the code up under a country restricts the lookup to them.
	 */
	readonly countries: readonly string[]
}

const FORM_RANK: Readonly<Record<PostalForm, number>> = { designated: 0, alnum: 1, numeric: 2 }

/**
 * The postcode candidates of a line in the order they compete, from the
 * recognitions of a recognizer's result.
 *
 * Every candidate is reduced to its code, and a printed prefix falls outside it.
 * The candidates are ordered longest first, then by earliest start, then by form
 * (designated, alnum, numeric) and shape ID, and a range that several shapes
 * match appears once, under the first of them.
 *
 * A candidate that a connector separates from the rest of a longer candidate is dropped
 * (see `isConnectorFragment`), so `69152` doesn't stand in `69152-656`.
 * The candidates that remain overlap, and none is dropped for overlapping another.
 *
 * A reader that looks each up, as the anchor painter does, keeps the first
 * that resolves among those that overlap.
 * A Somali shape matches `VT 05401`, and that candidate hides no ZIP code inside it.
 * {@linkcode disjointSpans} is the reduction for a reader that has no lookup to run.
 *
 * Training reads the same order in `mtf-channels`, from the same artifact.
 */
export function postalSpans(recognitions: ReadonlyArray<PostalRecognitionLike>, text: string): PostalSpan[] {
	const candidates: PostalSpan[] = []

	for (const recognition of recognitions) {
		if (!isPostalRecognition(recognition)) continue

		const shape = SHAPES[recognition.kind]!
		const printed = splitPrintedPostcode(recognition)

		const code = printed
			? recognition.text.length - recognition.text.slice(printed.prefix.length).trimStart().length
			: 0

		candidates.push({
			kind: recognition.kind,
			form: shape.form,
			start: recognition.start + code,
			end: recognition.end,
			countries: shape.countries,
		})
	}

	candidates.sort(
		(a, b) =>
			b.end - b.start - (a.end - a.start) ||
			a.start - b.start ||
			FORM_RANK[a.form] - FORM_RANK[b.form] ||
			(a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
	)

	// One candidate for each range, under the first shape that matches it,
	// with the countries of every shape that does.
	// The countries of a range that several shapes match are collected in a set and sorted once.
	const distinct: PostalSpan[] = []
	const merged = new Map<number, Set<string>>()

	for (const candidate of candidates) {
		const index = distinct.findIndex((earlier) => earlier.start === candidate.start && earlier.end === candidate.end)

		if (index === -1) {
			distinct.push(candidate)
		} else {
			const countries = merged.get(index) ?? new Set(distinct[index]!.countries)

			for (const country of candidate.countries) {
				countries.add(country)
			}

			merged.set(index, countries)
		}
	}

	for (const [index, countries] of merged) {
		distinct[index] = { ...distinct[index]!, countries: [...countries].toSorted() }
	}

	return distinct.filter((candidate) => !distinct.some((container) => isConnectorFragment(candidate, container, text)))
}

/**
 * The characters a code may be joined to its neighbors by: the hyphen-minus, the apostrophe, the
 * low line and the two curly single quotation marks, the connectors of the engine's `token` boundary.
 */
const CONNECTORS = "-'_‘’"

/**
 * Whether `candidate` is a piece of `container` that a connector separates from the rest.
 *
 * `69152` in `69152-656` and `0001` in `100-0001` are pieces of a longer code, and the longer code
 * claims them: a piece that resolves in the anchor table would anchor the code to another country's key.
 * A piece that white space separates, as `05401` in `VT 05401`, is no fragment,
 * because the longer candidate may be no postcode at all.
 */
function isConnectorFragment(candidate: PostalSpan, container: PostalSpan, text: string): boolean {
	if (container.start > candidate.start || container.end < candidate.end) return false

	const cutAtStart = candidate.start > container.start
	const cutAtEnd = candidate.end < container.end

	if (!cutAtStart && !cutAtEnd) return false

	return (
		(!cutAtStart || CONNECTORS.includes(text[candidate.start - 1]!)) &&
		(!cutAtEnd || CONNECTORS.includes(text[candidate.end]!))
	)
}

/**
 * The candidates that stand once each overlap is settled in favor of the first, in start order.
 *
 * `accept` decides whether a candidate stands at all, as an anchor lookup decides whether a key exists.
 * A candidate it refuses hides no other.
 */
export function disjointSpans(
	spans: readonly PostalSpan[],
	accept: (span: PostalSpan) => boolean = () => true
): PostalSpan[] {
	const accepted: PostalSpan[] = []

	for (const span of spans) {
		if (accepted.some((kept) => span.start < kept.end && kept.start < span.end) || !accept(span)) continue

		accepted.push(span)
	}

	return accepted.toSorted((a, b) => a.start - b.start)
}
