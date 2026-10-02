/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reading a house number and a street out of the columns a publisher supplies.
 *
 * Publishers divide the same address two ways. Some write one street line that holds the number and
 * the street together, which {@linkcode splitStreetLine} separates. Others write the number across
 * two columns, which {@linkcode composeHouseNumber} joins. Every adapter facing either shape uses
 * these, so an edge case fixed here is fixed for all of them.
 */

/**
 * A leading house number on a US-style street line contains digits and an optional hyphenated range
 * (Queens `40-12`), an optional single alpha suffix (`101A`), then whitespace, then the rest.
 *
 * The remainder must stay `(\S.*)` and must not become `(.+)`: `\s+` and `.` both match a tab,
 * so `\s+(.+)$` lets the engine split a run of tabs between the two groups every possible way
 * before failing — quadratic backtracking on attacker-shaped input.
 * The required non-space start removes the overlap.
 *
 * Group 2 is trimmed by the caller either way, so the two forms are indistinguishable on real input.
 * Only the failure cost differs.
 */
export const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(\S.*)$/

/**
 * A street line split into its house number and the remainder.
 */
export interface SplitStreetLine {
	house_number?: string
	street: string
}

/**
 * Split a US-style street line on {@link HOUSE_NUMBER_PREFIX}.
 *
 * The US CSV sources follow USPS Publication 28 conventions with hand-entry drift.
 * The leading digit run is the house number (`"123 Main St"`, `"6450 W Indian School Rd"`),
 * and the regex tolerates one trailing letter (`"123A Main St"`) plus an optional
 * hyphenated half (`"40-12 Bell Blvd"`, common in NYC and suburban garden-apartment
 * numbering. Hawaii uses it island-wide — `"47-470 Hui Aeko Place"`).
 *
 * @returns `null` for blank input.
 * An input that does not match the prefix shape, including `"PO Box 1234"`,
 * `"RR 2 Box 67"` and `"HC 1"`, becomes a single `street` value rather than being mangled,
 * so the model sees the original surface form and downstream classifiers pick it up.
 * A caller that needs those forms recognized as something other than a street
 * (see `usgov-irs-bmf`) tests for them before calling this.
 */
export function splitStreetLine(line: string): SplitStreetLine | null {
	const trimmed = line.trim()

	if (!trimmed) return null

	const match = HOUSE_NUMBER_PREFIX.exec(trimmed)

	if (match) return { house_number: match[1], street: match[2]!.trim() }

	return { street: trimmed }
}

/**
 * Joins a house number to the suffix a publisher stores in its own column.
 *
 * Several registers split a house number across two columns: BAN writes `10`
 * and `bis`, Kartverket writes `12` and `B`.
 * The separator differs per publisher, so the caller states it, and the two values are
 * trimmed here because a publisher's padding is not part of the number.
 *
 * @param number The numeric part, from the publisher's number column.
 * @param suffix The letter or word that follows it, from the publisher's suffix column.
 * @param separator What to place between them.
 * Kartverket joins `12` and `B` as `12B`; BAN joins `10` and `bis` as `10 bis`.
 * @returns The joined number, or an empty string when the numeric part is absent.
 * A caller treats the empty string as a row with no house number rather than assigning it.
 */
export function composeHouseNumber(number: string, suffix: string, separator = ""): string {
	const trimmedNumber = number.trim()

	if (!trimmedNumber) return ""

	const trimmedSuffix = suffix.trim()

	return trimmedSuffix ? `${trimmedNumber}${separator}${trimmedSuffix}` : trimmedNumber
}
