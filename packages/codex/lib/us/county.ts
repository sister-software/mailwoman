// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The words a US county or county equivalent is written with after its name.
 *
 *   The Census Bureau's legal/statistical area descriptions name each county
 *   equivalent's kind: `County`, `Parish` (Louisiana), `Borough`, `Census Area`,
 *   `City and Borough` and `Municipality` (Alaska).
 *   An address writes the word after the name (`Polk County`, `St. Charles Parish`),
 *   and the word belongs to the county's span.
 *
 *   An independent city (`Richmond city`, written `City of Richmond`) is a county
 *   equivalent whose name is also a locality's, so it isn't a suffix here:
 *   a row that writes it can't tell the city from the county.
 *
 * @see {@link https://www.census.gov/library/reference/code-lists/legal-status-codes.html Census Bureau, Legal/Statistical Area Description codes}
 */

/**
 * The county-equivalent designators an address writes after the name, longest first,
 * so `Juneau City and Borough` matches `City and Borough` before `Borough`.
 */
export const US_COUNTY_DESIGNATORS = [
	"City and Borough",
	"Census Area",
	"Municipality",
	"Borough",
	"Parish",
	"County",
] as const

/**
 * One of {@link US_COUNTY_DESIGNATORS}.
 */
export type USCountyDesignator = (typeof US_COUNTY_DESIGNATORS)[number]

/**
 * A county surface split into its name and the designator written after it.
 */
export interface USCountyName {
	/**
	 * The name without its designator: `Polk` in `Polk County`.
	 */
	name: string
	/**
	 * The designator in its table spelling, whatever case the input wrote it in.
	 */
	designator: USCountyDesignator
}

const DESIGNATOR_SUFFIX = new RegExp(`^(.+?)\\s+(${US_COUNTY_DESIGNATORS.join("|")})$`, "iu")

/**
 * Splits `Polk County` into `Polk` and `County`, matching the designator in any case,
 * or returns `null` when the surface doesn't end in one of {@link US_COUNTY_DESIGNATORS}.
 */
export function splitUSCountyDesignator(surface: string): USCountyName | null {
	const match = DESIGNATOR_SUFFIX.exec(surface.trim())

	if (!match) return null

	const written = match[2]!.toLowerCase()
	const designator = US_COUNTY_DESIGNATORS.find((d) => d.toLowerCase() === written)!

	return { name: match[1]!.trim(), designator }
}

/**
 * Whether `surface` writes the county `county` with a designator after it:
 * `Polk County` against `Polk`, `DENTON COUNTY` against `Denton`.
 *
 * `county` may end in its own designator (`Bristol Bay Borough`), and the two
 * names are compared case-insensitively without it.
 * A surface with no designator (`Denton` against `Denton`) isn't a county surface,
 * because a city commonly shares its county's name.
 */
export function namesUSCounty(surface: string, county: string): boolean {
	const written = splitUSCountyDesignator(surface)

	if (!written) return false

	const own = splitUSCountyDesignator(county)?.name ?? county.trim()

	return own.length > 0 && written.name.toLowerCase() === own.toLowerCase()
}
