// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   When a `spatial` recognition may be trusted.
 *
 *   A consumer may skip the address encoder only when the grammar accepted, the validator
 *   accepted (`validation.status` is `"validated"`), and the span is the whole input.
 *   An embedded code is a candidate: `Managua, VFQ6+92P` holds a code, and the text is an address.
 *
 *   A compact DIGIPIN is never deterministic.
 *   Ten characters from `2` to `9` and the letters `C F J K L M P T` are also
 *   a phone number, a count or a postcode.
 *
 *   A display-form DIGIPIN is deterministic only when it holds a letter.
 *   Ten digits from `2` to `9` in the form three, three and four, with hyphens, are also
 *   how a North American phone number is written, so the all-digit form is a candidate.
 *
 *   The validator still reports it as a well-formed DIGIPIN.
 *   India Post's technical document defines no prefix or other marker that would settle the question.
 *
 *   A short Plus Code is deterministic as a code, and it decodes only beside a reference position.
 *
 *   A consumer that trims its input passes the trimmed text, because the grammars
 *   admit no leading or trailing space.
 *   A GeoJSON text is the exception, as JSON allows white space around its value.
 *
 *   The module imports the family's declarations for the kind names, so a bundle
 *   that imports it holds the `spatial` artifact as well.
 */

import { SpatialKind } from "#spatial.generated"

const CANDIDATE_ONLY: ReadonlySet<string> = new Set([SpatialKind.DigipinCompact])
const SPATIAL_KINDS: ReadonlySet<string> = new Set(Object.values(SpatialKind))

/**
 * Whether a consumer may treat a recognition as the reading of `text` without the address encoder.
 *
 * ```ts
 * const { recognitions } = recognizer.recognize(text)
 * const code = recognitions.find((recognition) => isDeterministicSpatial(recognition, text))
 * ```
 */
export function isDeterministicSpatial(
	recognition: {
		readonly kind: string
		readonly start: number
		readonly end: number
		readonly validation: { readonly status: string }
	},
	text: string
): boolean {
	// The text of a span is `text.slice(start, end)`.
	if (
		recognition.kind === SpatialKind.DigipinDisplay &&
		!/[A-Za-z]/u.test(text.slice(recognition.start, recognition.end))
	) {
		return false
	}

	return (
		SPATIAL_KINDS.has(recognition.kind) &&
		!CANDIDATE_ONLY.has(recognition.kind) &&
		recognition.validation.status === "validated" &&
		recognition.start === 0 &&
		recognition.end === text.length
	)
}
