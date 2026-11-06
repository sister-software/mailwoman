/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The strict airport-code predicate over the `iata-airport-membership` bitset. An import of it retains that
 *   2,197-byte bitset and the reader, and no airport record, coordinate or name.
 */

import { iataAirportMembershipArtifact } from "#artifacts/iata-airport-membership"
import { type Parsed, ParseFailure, shapeFailure } from "#errors"
import { encode3 } from "#key"
import { Artifact } from "#rgy1/reader"
import { BitsetView } from "#rgy1/views"
import type { IATA } from "#types"

let bitset: BitsetView | null = null

/**
 * Returns the airport membership bitset, parsing the artifact on first use.
 */
export function airportMembership(): BitsetView {
	bitset ??= BitsetView.of(Artifact.parse(iataAirportMembershipArtifact()))

	return bitset
}

/**
 * Whether `input` is an IATA airport code in its canonical spelling, in the built profile.
 *
 * The open profile holds airports, heliports and seaplane bases from OurAirports
 * and no metropolitan code, so `PAR` is refused here although IATA assigns it to Paris.
 */
export function isAirportCode(input: string): input is IATA.AirportCode {
	return airportMembership().test(encode3(input))
}

/**
 * The branded airport code, or the reason the input was refused.
 */
export function parseAirportCode(input: string): Parsed<IATA.AirportCode> {
	const shape = shapeFailure(input, 3, true)

	if (shape) return { ok: false, reason: shape, input }

	if (!isAirportCode(input)) return { ok: false, reason: ParseFailure.NotFound, input }

	return { ok: true, value: input }
}
