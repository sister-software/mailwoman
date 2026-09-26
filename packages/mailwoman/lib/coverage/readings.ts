/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a jurisdiction's coverage row says, as a value rather than as a formatted string.
 *
 *   The classification lives here and the phrasing stays with each caller, so a reading added here fails
 *   to compile at every caller that does not handle it.
 */

import type { CountryCoverage } from "#coverage/census"

/**
 * What the corpus and the admission list together say about training a jurisdiction.
 *
 * `Absent` (no layer holds the code) and `Declined` (the admission list omits a code the gazetteer
 * or the board does hold) are different findings; `DeclinedWithRows` means rows exist
 * but contribute no training signal, so closing it takes a `country_weights` entry
 * rather than data, and `AdmittedEmpty` is the mirror.
 */
export const ParseReading = {
	Absent: "absent",
	Declined: "declined",
	DeclinedWithRows: "declined-with-rows",
	AdmittedEmpty: "admitted-empty",
	RowsWithStreet: "rows-with-street",
	RowsWithoutStreet: "rows-without-street",
} as const

export type ParseReading = (typeof ParseReading)[keyof typeof ParseReading]

/**
 * Which reading a jurisdiction's parse capability falls under.
 */
export function parseReading(coverage: CountryCoverage | undefined): ParseReading {
	if (!coverage) return ParseReading.Absent

	if (!coverage.admitted) {
		return coverage.corpusRows > 0 ? ParseReading.DeclinedWithRows : ParseReading.Declined
	}

	if (coverage.corpusRows === 0) return ParseReading.AdmittedEmpty

	return coverage.corpusStreetRows > 0 ? ParseReading.RowsWithStreet : ParseReading.RowsWithoutStreet
}

/**
 * How finely a jurisdiction resolves.
 *
 * `Rooftop` is reserved for a rooftop database a consumer can obtain; build-local rooftop
 * databases look identical from inside the repository and still read `Locality`.
 */
export const GeocodeReading = {
	Absent: "absent",
	Rooftop: "rooftop",
	Locality: "locality",
	None: "none",
} as const

export type GeocodeReading = (typeof GeocodeReading)[keyof typeof GeocodeReading]

/**
 * Which reading a jurisdiction's geocode capability falls under.
 */
export function geocodeReading(coverage: CountryCoverage | undefined): GeocodeReading {
	if (!coverage) return GeocodeReading.Absent

	if (coverage.geocodeTier === "rooftop-published") return GeocodeReading.Rooftop

	return coverage.gazetteerPlaces > 0 ? GeocodeReading.Locality : GeocodeReading.None
}
