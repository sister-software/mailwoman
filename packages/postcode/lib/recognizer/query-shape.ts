// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The recognizer the parse pipeline reads its structural evidence from.
 *
 *   Two generations answer, selected by the model card's `requires.query_shape`.
 *   The `legacy` generation composes the `structure` family of `@mailwoman/recognizer` with
 *   the `postcode_legacy` family, and reports the thirteen hand-written postcode patterns.
 *
 *   The `postal` generation composes `structure` with the `postal` family and reports a
 *   hit for each postcode candidate of the 181 countries' syntax and each PO box.
 *
 *   This module lives in `@mailwoman/postcode` because both families do:
 *   `@mailwoman/recognizer` may not import this package, and this package already imports it.
 *
 *   The first call instantiates the WebAssembly engine, as every recognizer does.
 *   Call `init` from `@mailwoman/recognizer` first where synchronous compilation is refused.
 *
 *   Every consumer that holds a model passes the model's generation.
 *
 *   A `postal` shape records its generation, so a consumer that receives a shape follows it.
 *   A `legacy` shape holds no such field, and its bytes equal the original classifier's.
 */

import type { CountrySet } from "@mailwoman/codex/country/sets"
import type { NormalizedInputLite } from "@mailwoman/core/pipeline/types"
import { createRecognizer, type Recognizer } from "@mailwoman/recognizer"
import { specifyStructure } from "@mailwoman/recognizer/query-shape/script-run"
import { structure } from "@mailwoman/recognizer/structure"
import type { KnownFormatHit, StructureFields, TextSpan } from "@mailwoman/recognizer/types"

import type { PostcodeLegacyFields } from "#recognizer/fields"
import { postal } from "#recognizer/postal.generated"
import { type PostalFormatHit, postalFormatHits } from "#recognizer/postal/formats"
import { postcodeLegacy } from "#recognizer/postcode_legacy.generated"
import { regionAbbreviationsOf } from "#recognizer/region-abbreviations"
import { QueryShapeGeneration } from "#recognizer/rule-generation"

/**
 * One known-format hit of either generation.
 *
 * A `legacy` hit holds no countries, form or locale.
 */
export type QueryShapeFormatHit = KnownFormatHit & Partial<Omit<PostalFormatHit, keyof KnownFormatHit>>

/**
 * A region abbreviation of either generation.
 *
 * The `legacy` generation reports the text as `span`, and the `postal` generation reports
 * the span's offsets and the countries that hold the abbreviation as a subdivision code.
 */
export interface QueryShapeRegionAbbreviation {
	readonly start: number
	readonly span: string | TextSpan
	readonly countries?: CountrySet
}

/**
 * The structural evidence of one text: character class, scripts, tokens, segments,
 * region abbreviations and length, with the postcode and PO box formats it holds.
 *
 * Offsets are UTF-16 code units, half-open.
 */
export type QueryShape = Omit<StructureFields, "regionAbbreviations"> & {
	readonly regionAbbreviations: ReadonlyArray<QueryShapeRegionAbbreviation>
	readonly knownFormats: ReadonlyArray<QueryShapeFormatHit>
	/**
	 * The generation that computed the shape.
	 *
	 * The `legacy` generation omits the field, and a reader treats an absent one as `legacy`.
	 */
	readonly generation?: QueryShapeGeneration
}

let legacyRecognizer: Recognizer<[typeof structure, typeof postcodeLegacy]> | null = null
let postalRecognizer: Recognizer<[typeof structure, typeof postal]> | null = null

/**
 * Computes the {@link QueryShape} of a string or normalized input.
 *
 * @param generation The model card's `requires.query_shape`, defaulting to `legacy`.
 *
 * @example
 * 	const shape = computeQueryShape("350 5th Ave, New York, NY 10118")
 * 	shape.knownFormats.find((hit) => hit.format === "us_zip") // defined
 * 	shape.segments.length // 4
 */
export function computeQueryShape(
	input: string | NormalizedInputLite,
	generation: QueryShapeGeneration = QueryShapeGeneration.Legacy
): QueryShape {
	const text = typeof input === "string" ? input : input.normalized

	if (generation === QueryShapeGeneration.Postal) {
		postalRecognizer ??= createRecognizer([structure, postal])

		const { fields, recognitions } = postalRecognizer.recognize(text)
		const specified = specifyStructure(fields, text)

		return {
			...specified,
			regionAbbreviations: regionAbbreviationsOf(specified.tokenClasses),
			knownFormats: postalFormatHits(recognitions, specified.tokenClasses, text),
			generation,
		}
	}

	legacyRecognizer ??= createRecognizer([structure, postcodeLegacy])

	// The legacy shape stays as the engine returned it, with no `generation` field,
	// so it equals the original byte for byte.
	return legacyRecognizer.recognize(text).fields as StructureFields & PostcodeLegacyFields
}
