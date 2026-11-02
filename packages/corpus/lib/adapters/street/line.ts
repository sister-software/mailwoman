/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module reads a house number and a street out of the columns a publisher supplies.
 *
 * Publishers divide the same address two ways. Some write one street line that holds the number and
 * the street together. {@linkcode splitStreetLine} separates that line for a number-first country and
 * {@linkcode splitTrailingStreetLine} for a number-last one. Others write the number across
 * two columns. {@linkcode composeHouseNumber} joins those. Every adapter facing either shape uses
 * these, so an edge case fixed here is fixed for all of them.
 *
 * Which of the two split functions a country takes is `STREET_ORDERS` in
 * `packages/mailwoman/tools/dev-tools/codex/street-orders.ts`, whose values reach the generated
 * layouts `@mailwoman/codex/address/layouts` serves.
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
 * A trailing house number on a number-last street line contains digits,
 * an optional single alpha suffix written against them (`39A`), and an optional slash-
 * or hyphen-joined subdivision (`2/TER`, `16/18`, `12-B`).
 *
 * The street and the number are separated by whitespace, a comma, or both,
 * because a publisher in a number-last country may write either: Italy's ANAC release
 * holds `VIA INDIPENDENZA, 41` and `VIA MAZZINI 7` in the same column.
 * The separator is required, so `VIA1` stays one street name.
 *
 * Group 1 starts at `\S` and the lazy `.*?` is bounded by that required separator,
 * so a run of whitespace between the two groups has one split rather than every possible split.
 * That is the same backtracking argument {@linkcode HOUSE_NUMBER_PREFIX} records, read from the other end.
 */
export const HOUSE_NUMBER_SUFFIX = /^(\S.*?)[\s,]+(\d+[A-Za-z]?(?:\s*[/-]\s*[0-9A-Za-z]{1,4})?)$/u

/**
 * Split a number-last street line on {@link HOUSE_NUMBER_SUFFIX}.
 *
 * A number-last country writes the number after the street name.
 * `STREET_ORDERS` records that order for Italy, Germany, Finland and 150 other jurisdictions.
 *
 * Whitespace inside the line is collapsed, and the separators inside a subdivided
 * number are closed up, so `VIA PERUGIA 2 / A` yields `2/A`.
 *
 * @returns `null` for blank input.
 * A line that ends in anything but a number becomes a single `street` value
 * rather than being mangled, as `PIAZZA CASTELLO` and `VIALE ROMA SNC` do.
 * A caller that treats an unplaced number inside such a line as a defect tests
 * the returned `street` for a digit.
 * This function leaves that decision to the caller, because a street name can legitimately hold a digit.
 */
export function splitTrailingStreetLine(line: string): SplitStreetLine | null {
	const trimmed = line.replaceAll(/\s+/gu, " ").trim()

	if (!trimmed) return null

	const match = HOUSE_NUMBER_SUFFIX.exec(trimmed)

	if (!match) return { street: trimmed }

	return { house_number: match[2]!.replaceAll(/\s*([/-])\s*/gu, "$1"), street: match[1]!.trim() }
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
