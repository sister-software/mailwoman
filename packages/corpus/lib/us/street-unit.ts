/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Splits a secondary unit written at the end of a US street line, such as `KING ST STE 300`.
 */

import { matchPOBox } from "@mailwoman/codex/us/po-box"
import { isUnitDesignatorToken, matchLeadingDesignator } from "@mailwoman/codex/us/unit-designator"

import { splitStreetLine } from "#adapters/street-line"

/**
 * A street line with its trailing secondary unit separated.
 */
export interface StreetWithUnit {
	street: string
	unit: string
}

/**
 * A register's second address line as a unit, or `null` when it holds something else.
 *
 * Most filled second lines open with a USPS secondary unit designator
 * (`SUITE 200`, `STE. 4`, `APT 2B`, `DEPARTMENT OF SURGERY`) or a bare number sign (`#200`).
 * The rest name a recipient, a building or a mail stop (`ATTN: BILLING`, `C/O …`, `MEDICAL OFFICE BUILDING`).
 *
 * A caller leaves those out of the row rather than joining them to the street span,
 * because they belong to neither the street nor the unit.
 */
export function unitLine(line: string): string | null {
	const trimmed = line.trim()

	if (!trimmed) return null

	if (/^#\s*\w/u.test(trimmed)) return trimmed

	const [first = ""] = trimmed.split(/\s+/u)

	return matchLeadingDesignator(first.replace(/[.,]$/u, "")) ? trimmed : null
}

/**
 * The address components written on one US street line: a PO box, or a house number, street and unit.
 */
export type USStreetLineComponents = { po_box: string } | { house_number?: string; street: string; unit?: string }

/**
 * Splits one US street line, as a register writes it, into its address components.
 *
 * A whole line that is a box designator and an identifier holding a digit
 * (`PO BOX 846`, `P.O. Box 10240`) becomes `po_box`.
 * The digit requirement keeps a street such as `BOX ELDER RD` a street.
 *
 * Any other line takes the house number off its start with `splitStreetLine`
 * and a secondary unit off its end with {@linkcode splitTrailingUnit}.
 *
 * @returns `null` for a blank line.
 */
export function splitUSStreetLine(line: string): USStreetLineComponents | null {
	const box = matchPOBox(line)

	if (box && /\d/u.test(box.id)) return { po_box: line.trim() }
	const split = splitStreetLine(line)

	if (!split) return null
	const trailing = splitTrailingUnit(split.street)

	return {
		...(split.house_number ? { house_number: split.house_number } : {}),
		street: trailing?.street ?? split.street,
		...(trailing ? { unit: trailing.unit } : {}),
	}
}

/**
 * An identifier after a designator contains a digit or is one letter: `300`, `2B`, `E3`, `C`.
 *
 * A designator token followed by a word keeps both in the street, so `OLD FRONT ST`
 * and `KEY WEST AVE` are not split.
 */
const UNIT_IDENTIFIER = /^(?:\S*\d\S*|[A-Za-z])$/u

const isIdentifier = (token: string) => UNIT_IDENTIFIER.test(token.replace(/^#/u, ""))

const isDesignator = (token: string) => isUnitDesignatorToken(token.replace(/\.$/u, ""))

/**
 * Splits a USPS secondary unit off the end of a street line, after the house number is removed.
 *
 * The unit is a Publication 28 designator followed by an identifier
 * (`STE 300`, `APT. 2B`, `SUITE # 200`, `BUILDING #500`), or a number sign joined to one (`#120`).
 * The designator is never the street's first word, so `SUITE B WESTGATE DRIVE`
 * and `PIER 39` keep their street.
 *
 * A comma between the street and the unit is dropped from the street.
 * A line ending in two units (`MAIN ST STE 300 BLDG 4`) yields both as one unit, in the order written.
 *
 * @returns `null` when the line ends in no unit.
 */
export function splitTrailingUnit(line: string): StreetWithUnit | null {
	const last = splitLastUnit(line)

	if (!last) return null
	const earlier = splitTrailingUnit(last.street)

	return earlier ? { street: earlier.street, unit: `${earlier.unit} ${last.unit}` } : last
}

/**
 * Splits the last unit off `line`, or returns `null`.
 */
function splitLastUnit(line: string): StreetWithUnit | null {
	const tokens = line.trim().split(/\s+/u)

	const at = (start: number) => ({
		street: tokens.slice(0, start).join(" ").replace(/\s*,$/u, ""),
		unit: tokens.slice(start).join(" "),
	})

	// The unit starts at the designator, so a street word must come before it.
	const startsAfterStreet = (start: number) => start >= 1
	const [identifier = "", sign, designatorBeforeSign] = tokens.toReversed()

	// `SUITE # 200`: the designator, a separate number sign, then the identifier.
	if (
		startsAfterStreet(tokens.length - 3) &&
		sign === "#" &&
		isDesignator(designatorBeforeSign ?? "") &&
		isIdentifier(identifier)
	) {
		return at(tokens.length - 3)
	}

	// `STE 300` or `BUILDING #500`: the designator, then the identifier.
	if (startsAfterStreet(tokens.length - 2) && isDesignator(sign ?? "") && isIdentifier(identifier)) {
		return at(tokens.length - 2)
	}

	// `#120`: a number sign joined to the identifier.
	if (startsAfterStreet(tokens.length - 1) && /^#\S/u.test(identifier) && isIdentifier(identifier)) {
		return at(tokens.length - 1)
	}

	return null
}
