/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The strict alpha-3 country-code predicate over the `iso3166-1-alpha3-membership` bitset. An import of it retains
 *   that 2,197-byte bitset and the reader, and no name, airport or record.
 */

import { iso31661Alpha3MembershipArtifact } from "#artifacts/iso3166-1/alpha3-membership"
import { type Parsed, ParseFailure, shapeFailure } from "#errors"
import { encode3 } from "#key"
import { Artifact } from "#rgy1/reader"
import { BitsetView } from "#rgy1/views"
import type { ISO } from "#types"

let bitset: BitsetView | null = null

/**
 * Returns the alpha-3 membership bitset, parsing the artifact on first use.
 */
export function alpha3Membership(): BitsetView {
	bitset ??= BitsetView.of(Artifact.parse(iso31661Alpha3MembershipArtifact()))

	return bitset
}

/**
 * Whether `input` is an officially assigned alpha-3 code in its canonical spelling, in the built profile.
 *
 * `AUS` is one.
 * `aus` and `AU` are not.
 *
 * A former code such as `DDR` is not: the records artifact still describes it.
 */
export function isCountryCodeAlpha3(input: string): input is ISO.CountryCode_3166_1_Alpha3 {
	return alpha3Membership().test(encode3(input))
}

/**
 * The branded alpha-3 code, or the reason the input was refused.
 */
export function parseCountryCodeAlpha3(input: string): Parsed<ISO.CountryCode_3166_1_Alpha3> {
	const shape = shapeFailure(input, 3, true)

	if (shape) return { ok: false, reason: shape, input }

	if (!isCountryCodeAlpha3(input)) return { ok: false, reason: ParseFailure.NotFound, input }

	return { ok: true, value: input }
}
