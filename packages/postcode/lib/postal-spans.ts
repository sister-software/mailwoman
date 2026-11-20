// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The postcode spans of a line, from the `postal` family.
 *
 *   This is the one finder of postcode-shaped spans.
 *   The serving side reads it here.
 *
 *   The training encoder reads the same artifact through `recognize-core` in
 *   `packages/mtf/crates/mtf-channels/src/finders.rs`, with the same order and the same reduction.
 *
 *   A span is the code the anchor table looks up, so a printed prefix is outside it.
 *   `postalSpans` in `./recognizer/postal/readers.ts` states the order of the candidates,
 *   and the family's definition states the case rule: every shape matches either case.
 *
 *   The engine loads on the first call.
 */

import type { CountrySet } from "@mailwoman/codex/country/sets"
import { createRecognizer } from "@mailwoman/recognizer"

import { postal, type PostalForm, postalSpans, type PostalSpan } from "#recognizer/postal"
import { POSTAL_FORMAT, postalFormatHits } from "#recognizer/postal/formats"

const recognizer = createRecognizer([postal])

/**
 * The postcode candidates of `text` in the order they compete, with UTF-16 offsets.
 *
 * The candidates overlap.
 * See `postalSpans`, and `disjointSpans` for the reduction.
 */
export function findPostcodeSpans(text: string): PostalSpan[] {
	if (!text) return []

	return postalSpans(recognizer.recognize(text).recognitions, text)
}

/**
 * One postcode the `postal` family admits as evidence in a line.
 */
export interface PostcodeHit {
	/**
	 * UTF-16 offsets of the hit, with the printed prefix of a printed shape.
	 */
	readonly start: number
	readonly end: number
	/**
	 * Where the code starts: after the prefix and its white space for a printed shape,
	 * and at `start` otherwise.
	 */
	readonly codeStart: number
	/**
	 * `designated` for a printed shape, and otherwise `alnum` or `numeric` by what the span holds.
	 */
	readonly form: PostalForm
	readonly countries: CountrySet
}

/**
 * The postcode hits of `text`, ordered by start and then longest first.
 *
 * These are the postcode hits of `postalFormatHits`.
 * That reader refuses a candidate with no digit, a bare candidate that reads as ordinary
 * text (`TX 75001`, `77A Neil`), and a piece a connector separates from a longer code.
 * The hits overlap.
 */
export function findPostcodeHits(text: string): PostcodeHit[] {
	if (!text) return []

	const recognitions = recognizer.recognize(text).recognitions
	const spans = postalSpans(recognitions, text)

	return postalFormatHits(recognitions, [], text).flatMap((hit) => {
		if (hit.format !== POSTAL_FORMAT || !hit.form || !hit.countries) return []

		const { start, end } = hit.span

		// The code of a printed hit is the longest standing span it ends with.
		const codeStarts =
			hit.form === "designated"
				? spans.filter((span) => span.end === end && span.start > start).map((span) => span.start)
				: []

		const codeStart = codeStarts.length ? Math.min(...codeStarts) : start

		return [{ start, end, codeStart, form: hit.form, countries: hit.countries }]
	})
}
