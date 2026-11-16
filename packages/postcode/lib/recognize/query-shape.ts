// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The recognizer the parse pipeline reads its structural evidence from.
 *
 *   It composes the `structure` family of `@mailwoman/recognize` with the `postcode_legacy`
 *   family once, and returns the structural fields together with `knownFormats`.
 *   This module lives in `@mailwoman/postcode` because the legacy family does:
 *   `@mailwoman/recognize` may not import this package, and this package already imports it.
 *
 *   The first call instantiates the WebAssembly engine, as every recognizer does.
 *   Call `init` from `@mailwoman/recognize` first where synchronous compilation is refused.
 */

import type { NormalizedInputLite } from "@mailwoman/core/pipeline/types"
import { createRecognizer, type Recognizer } from "@mailwoman/recognize"
import { structure } from "@mailwoman/recognize/structure"
import type { StructureFields } from "@mailwoman/recognize/types"

import type { PostcodeLegacyFields } from "#recognize/fields"
import { postcodeLegacy } from "#recognize/postcode_legacy.generated"

/**
 * The structural evidence of one text: character class, scripts, tokens, segments,
 * region abbreviations and length, with the postcode and PO box formats it holds.
 *
 * Offsets are UTF-16 code units, half-open.
 */
export type QueryShape = StructureFields & PostcodeLegacyFields

let recognizer: Recognizer<[typeof structure, typeof postcodeLegacy]> | null = null

/**
 * Computes the {@link QueryShape} of a string or normalized input.
 *
 * @example
 * 	const shape = computeQueryShape("350 5th Ave, New York, NY 10118")
 * 	shape.knownFormats.find((hit) => hit.format === "us_zip") // defined
 * 	shape.segments.length // 4
 */
export function computeQueryShape(input: string | NormalizedInputLite): QueryShape {
	recognizer ??= createRecognizer([structure, postcodeLegacy])

	return recognizer.recognize(typeof input === "string" ? input : input.normalized).fields
}
