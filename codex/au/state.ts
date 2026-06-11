/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australian states and territories (ISO 3166-2:AU). Australia Post's addressing guidelines put the
 *   state abbreviation on the last line between the locality and the 4-digit postcode ("Line 3
 *   should contain the locality or suburb, state and postcode and be written in capital letters" —
 *   addressing guidelines, accessed 2026-06-11), e.g. `SYDNEY NSW 2000`, `BUNBURY WA 6230`, `EUROA
 *   VIC 3664`. The abbreviation set is the ISO 3166-2:AU subdivision codes, which are the same
 *   codes Australia Post's own examples use (NSW, VIC, WA, QLD, ACT appear across the addressing
 *   guidelines and the barcode booklet).
 * @see {@link https://auspost.com.au/sending/guidelines/addressing-guidelines Australia Post addressing guidelines}
 * @see {@link https://www.iso.org/obp/ui/#iso:code:3166:AU ISO 3166-2:AU}
 */

/** State/territory abbreviation → full name (ISO 3166-2:AU subdivision set). */
export const AU_STATE_ABBREVIATIONS = {
	ACT: "Australian Capital Territory",
	NSW: "New South Wales",
	NT: "Northern Territory",
	QLD: "Queensland",
	SA: "South Australia",
	TAS: "Tasmania",
	VIC: "Victoria",
	WA: "Western Australia",
} as const satisfies Record<string, string>

/** An Australian state/territory abbreviation as written on the last address line. */
export type AuStateAbbreviation = keyof typeof AU_STATE_ABBREVIATIONS

/** Type-predicate for an AU state/territory abbreviation (case-insensitive). */
export function isAuStateAbbreviation(input: unknown): input is AuStateAbbreviation {
	return typeof input === "string" && Object.hasOwn(AU_STATE_ABBREVIATIONS, input.toUpperCase())
}
