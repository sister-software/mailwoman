/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Splits a US register's street line into a PO box, or a house number, street and unit.
 */

import { matchPOBox } from "@mailwoman/codex/us/po-box"
import { matchLeadingDesignator } from "@mailwoman/codex/us/unit/designator"

import { splitStreetLine } from "#adapters/street/line"
import type { StreetPlace, UnitSplitter } from "#adapters/street/unit"

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
 * A whole line that's a box designator and an identifier holding a digit
 * (`PO BOX 846`, `P.O. Box 10240`) becomes `po_box`.
 * The digit requirement keeps a street such as `BOX ELDER RD` a street.
 *
 * Any other line takes the house number off its start with `splitStreetLine`
 * and a secondary unit off its end with the shared unit splitter (`#adapters/street/unit`),
 * which reads USPS Publication 28's designators from the US codex table.
 *
 * @returns `null` for a blank line.
 */
export function splitUSStreetLine(
	line: string,
	units: UnitSplitter,
	place: Omit<StreetPlace, "country"> = {}
): USStreetLineComponents | null {
	const box = matchPOBox(line)

	if (box && /\d/u.test(box.id)) return { po_box: line.trim() }
	const split = splitStreetLine(line)

	if (!split) return null
	const trailing = units.split(split.street, { ...place, country: "US" })

	return {
		...(split.house_number ? { house_number: split.house_number } : {}),
		street: trailing?.street ?? split.street,
		...(trailing ? { unit: trailing.unit } : {}),
	}
}
