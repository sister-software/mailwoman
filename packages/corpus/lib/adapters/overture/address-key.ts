// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The address key that joins an Overture row to every other rendering of the same address.
 *
 *   An Overture row's `source_id` is a hash of its aligned components (`stableSourceID`).
 *   A re-run that adds the region or writes the postcode in another grouping gives the same address a new id,
 *   and the record id the split groups by doesn't hold across the re-run (#3457).
 *   The key reads the postcode, the locality, the house number, the street and the unit, each folded.
 *   It leaves out the region and the country, the two components a re-run adds to some rows and not others.
 *   A postcode keeps only its letters and digits, so `K7K6R2` and `K7K 6R2`, `54420-240` and `54420240` are
 *   one postcode.
 *
 *   The key's text comes from Overture's own fields.
 *   The adapter writes `street`, `number`, `unit` and `locality` verbatim and regroups only the postcode.
 */

import { type AddressKeyRow, aliasedSpanSQL, foldKeyText, labeledSpanText } from "#utils/address-key"

/**
 * The street tags whose spans make up the street.
 *
 * The affix relabel may split a street keyword into its own span,
 * and the joined text is the same either way.
 */
const STREET_TAGS: ReadonlySet<string> = new Set(["street_prefix", "street", "street_suffix"])

const POSTCODE_TAGS: ReadonlySet<string> = new Set(["postcode"])

const HOUSE_NUMBER_TAGS: ReadonlySet<string> = new Set(["house_number"])

/**
 * A postcode's letters and digits, lower case.
 */
function foldPostcode(text: string): string {
	return foldKeyText(text).replaceAll(" ", "")
}

/**
 * The folded postcode and the house number's digits, the part of the key a column scan can compute.
 *
 * @returns null when the row holds neither a postcode nor a locality.
 * The adapter writes no such row.
 */
export function overtureAddressBlock(row: AddressKeyRow): string | null {
	const postcode = foldPostcode(labeledSpanText(row, POSTCODE_TAGS))
	const number = labeledSpanText(row, HOUSE_NUMBER_TAGS).replaceAll(/\D/gu, "")

	if (!postcode && !row.span_tags.includes("locality")) return null

	return `${postcode}|${number}`
}

/**
 * {@linkcode overtureAddressBlock} as a DuckDB expression over a corpus file aliased `alias`.
 *
 * `lower` and the ASCII class agree with the JavaScript fold for the postcodes
 * Overture writes in Brazil, Mexico and Canada.
 * Those hold only ASCII letters, digits, a space and a hyphen.
 */
export function overtureAddressBlockSQL(alias: string): string {
	const text = (tag: string) => `coalesce(${aliasedSpanSQL(alias, tag)}, '')`

	return (
		`(regexp_replace(lower(${text("postcode")}), '[^0-9a-z]', '', 'g') || '|' || ` +
		`regexp_replace(${text("house_number")}, '[^0-9]', '', 'g'))`
	)
}

/**
 * The address key of one Overture row, `<postcode>|<locality>|<house number>|<street>|<unit>`.
 *
 * A row without a house number keys by its street within its postcode and locality.
 *
 * @returns null when the row has no street, or neither a postcode nor a locality.
 */
export function overtureAddressKey(row: AddressKeyRow): string | null {
	const street = foldKeyText(labeledSpanText(row, STREET_TAGS))
	const postcode = foldPostcode(labeledSpanText(row, POSTCODE_TAGS))
	const locality = foldKeyText(labeledSpanText(row, new Set(["locality"])))

	if (!street || (!postcode && !locality)) return null

	const number = foldKeyText(labeledSpanText(row, HOUSE_NUMBER_TAGS))
	const unit = foldKeyText(labeledSpanText(row, new Set(["unit"])))

	return `${postcode}|${locality}|${number}|${street}|${unit}`
}
