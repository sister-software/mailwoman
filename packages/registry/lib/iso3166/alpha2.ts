/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The strict alpha-2 country-code predicate over the `iso3166-1-alpha2-membership` bitset. An import of it retains
 *   that 85-byte bitset and the reader, and no name, airport or record.
 */

import { iso31661Alpha2MembershipArtifact } from "#artifacts/iso3166-1/alpha2-membership"
import { type Parsed, ParseFailure, shapeFailure } from "#errors"
import { encode2 } from "#key"
import { Artifact } from "#rgy1/reader"
import { BitsetView } from "#rgy1/views"
import type { ISO } from "#types"

let bitset: BitsetView | null = null

function membership(): BitsetView {
	bitset ??= BitsetView.of(Artifact.parse(iso31661Alpha2MembershipArtifact()))

	return bitset
}

/**
 * Whether `input` is an officially assigned alpha-2 code in its canonical spelling, in the built profile.
 *
 * `GB` is one.
 * `gb`, ` GB` and `GBR` are not.
 *
 * `canonicalSpelling` is the step that accepts the case or the whitespace.
 */
export function isCountryCodeAlpha2(input: string): input is ISO.CountryCode_3166_1_Alpha2 {
	return membership().test(encode2(input))
}

/**
 * The branded alpha-2 code, or the reason the input was refused.
 */
export function parseCountryCodeAlpha2(input: string): Parsed<ISO.CountryCode_3166_1_Alpha2> {
	const shape = shapeFailure(input, 2, true)

	if (shape) return { ok: false, reason: shape, input }

	if (!isCountryCodeAlpha2(input)) return { ok: false, reason: ParseFailure.NotFound, input }

	return { ok: true, value: input }
}
