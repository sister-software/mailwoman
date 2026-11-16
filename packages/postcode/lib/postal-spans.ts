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
 *   `postalSpans` in `./recognize/postal/readers.ts` states the order of the candidates,
 *   and the family's definition states the case rule: every shape matches either case.
 *
 *   The engine loads on the first call.
 */

import { createRecognizer } from "@mailwoman/recognize"

import { postal, postalSpans, type PostalSpan } from "#recognize/postal"

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
