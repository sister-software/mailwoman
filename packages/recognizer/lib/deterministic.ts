// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   When a coordinate recognition may be trusted.
 *
 *   A recognition is a claim about a span.
 *   A coordinate recognition makes three, and a consumer may skip the address
 *   encoder only when all three hold:
 *
 *   1. The grammar accepted, so the recognition exists.
 *   2. The validator accepted, so `validation.status` is `"validated"`.
 *      A pair out of range on an axis, a `geo:` URI in another coordinate system and a
 *      malformed parameter list are candidates with a typed rejection, and none has a payload.
 *   3. The span is the whole input, so `start` is 0 and `end` is the text's length.
 *      A pair inside a longer text is a candidate and a reading of only that span.
 *      `Apt 4, 12 Main St` holds the valid pair `4, 12`, and `12345 Main Street` holds the number `12345`.
 *      An embedded span never settles what the query is.
 *
 *   {@link isDeterministicCoordinate} states that rule.
 *   Everything else falls back to the address encoder.
 *
 *   The encoder sees the ambiguous reading with the rest of the text.
 *
 *   A consumer that trims its input passes the trimmed text, because the grammars
 *   admit no leading or trailing space.
 *
 *   A decimal pair reports the axis order it was read in.
 *   `lon_lat` means the written order was out of range and the other order was in range.
 *
 *   It is still deterministic under the rule above, and a consumer that wants
 *   only the order as written checks `order`.
 *
 *   The module imports the family's declarations for types and for the kind names,
 *   so a bundle that imports it holds the `coordinates` artifact as well.
 */

import { CoordinatesKind, type CoordinatesPayloads, type CoordinatesRejections } from "#coordinates.generated"
import type { Recognition, Validated } from "#family"

/**
 * A validated recognition of a coordinate shape that covers the whole input.
 */
export type DeterministicCoordinate = {
	[K in CoordinatesKind]: Recognition<K, CoordinatesPayloads[K], CoordinatesRejections[K]> & {
		readonly validation: Validated<CoordinatesPayloads[K]>
	}
}[CoordinatesKind]

const COORDINATE_KINDS: ReadonlySet<string> = new Set(Object.values(CoordinatesKind))

/**
 * Whether a consumer may treat a recognition as the reading of `text` without the address encoder.
 *
 * True only for a recognition of a coordinate shape whose validation is `"validated"`
 * and whose span is the whole text.
 * The module's documentation explains why an embedded or rejected recognition is insufficient.
 *
 * ```ts
 * const { recognitions } = recognizer.recognize(text)
 * const point = recognitions.find((recognition) => isDeterministicCoordinate(recognition, text))
 * ```
 */
export function isDeterministicCoordinate<
	R extends {
		readonly kind: string
		readonly start: number
		readonly end: number
		readonly validation: { readonly status: string }
	},
>(recognition: R, text: string): recognition is R & DeterministicCoordinate {
	return (
		COORDINATE_KINDS.has(recognition.kind) &&
		recognition.validation.status === "validated" &&
		recognition.start === 0 &&
		recognition.end === text.length
	)
}
