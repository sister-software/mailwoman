/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a jurisdiction's coverage row says, as a value rather than as a formatted string.
 *
 *   Two readers classify the same {@linkcode CountryCoverage} and phrase it differently: `mwdev_coverage`
 *   writes one line an agent reads, and `jurisdiction-coverage.run.ts` writes a table cell. Each wrote
 *   its own chain of conditions, so the two could disagree about which reading a row falls under while
 *   both looked correct on their own.
 *
 *   The classification lives here and the phrasing stays with each caller. A reading added here fails to
 *   compile at every caller that does not handle it, which is the property that keeps them agreeing.
 */

import type { CountryCoverage } from "#coverage/census"

/**
 * What the corpus and the admission list together say about training a jurisdiction.
 *
 * `Absent` and `Declined` are different findings.
 * `Absent` says no layer holds the code at all, while `Declined` says the admission
 * list omits a code the gazetteer or the board does hold.
 *
 * `DeclinedWithRows` is the Norway bug's shape: rows exist and contribute no training signal,
 * so closing it takes a `country_weights` entry rather than data.
 *
 * `AdmittedEmpty` is the mirror: the config admits the jurisdiction and the corpus
 * holds no row, so closing it takes data rather than a config line.
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
 *
 * `undefined` means the census covered no layer for the code, which is {@linkcode ParseReading.Absent}.
 * A caller that always holds a row never sees it.
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
 * `Rooftop` is reserved for a rooftop database a consumer can obtain.
 * Every other rooftop database is build-local and looks identical from inside the repository,
 * so a jurisdiction holding one still reads {@linkcode GeocodeReading.Locality}.
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
