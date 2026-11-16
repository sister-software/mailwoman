// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   When an `identifiers` recognition may be trusted.
 *
 *   A recognition of an identifier is a claim about a span that a consumer may rely on only
 *   when the grammar accepted, the validator accepted and the span is the whole input.
 *   Two kinds of identifier fail the rule whatever the validator reports.
 *
 *   A Census GEOID and a bare H3 cell are runs of digits, and a run of digits is
 *   also a house number, a postcode, a count or a year.
 *   The validator checks that the digits have the structure of the identifier,
 *   and the state code of a GEOID is a known FIPS code, but a recognition is a candidate
 *   until a membership check confirms that the area exists.
 *
 *   The prefixed kinds are deterministic, because the prefix is the evidence: `geohash.prefixed`,
 *   `gnis.reference`, `gnis.summary_url`, `h3.prefixed_cell`, `wof.reference` and `wof.spelunker_url`.
 *   Deterministic means the text is that kind of identifier.
 *
 *   It doesn't mean the identifier points at a place that exists.
 *
 *   The module imports the family's declarations for the kind names, so a bundle
 *   that imports it holds the `identifiers` artifact as well.
 */

import { IdentifiersKind } from "#identifiers.generated"

const CANDIDATE_ONLY: ReadonlySet<string> = new Set([
	IdentifiersKind.CensusGeoIDBlock,
	IdentifiersKind.CensusGeoIDBlockGroup,
	IdentifiersKind.CensusGeoIDCounty,
	IdentifiersKind.CensusGeoIDState,
	IdentifiersKind.CensusGeoIDTract,
	IdentifiersKind.H3Cell,
])

const IDENTIFIER_KINDS: ReadonlySet<string> = new Set(Object.values(IdentifiersKind))

/**
 * Whether a consumer may treat a recognition as the reading of `text` without the address encoder.
 *
 * ```ts
 * const { recognitions } = recognizer.recognize(text)
 * const identifier = recognitions.find((recognition) => isDeterministicIdentifier(recognition, text))
 * ```
 */
export function isDeterministicIdentifier(
	recognition: {
		readonly kind: string
		readonly start: number
		readonly end: number
		readonly validation: { readonly status: string }
	},
	text: string
): boolean {
	return (
		IDENTIFIER_KINDS.has(recognition.kind) &&
		!CANDIDATE_ONLY.has(recognition.kind) &&
		recognition.validation.status === "validated" &&
		recognition.start === 0 &&
		recognition.end === text.length
	)
}
