// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The address key that joins a NAD row to every other NAD row of the same address.
 *
 *   NAD's releases give one address a new UUID when a contributor resubmits it, so the record id the
 *   split groups by doesn't hold across ingests (#3125). The key reads a row's labeled spans and holds
 *   the state, the five-digit ZIP Code, the house number, the street and the unit, each folded so that
 *   every rendering the corpus writes of one record gives one key: case, spacing and commas, a state
 *   written in full, a ZIP+4 with or without its dash, and directionals, street suffixes and unit
 *   designators abbreviated or expanded.
 *
 *   A NAD row holds no county column. The adapter reads `County` only to detect a county written as the
 *   place. The ZIP Code within its state stands in for it, and a house number on one street under one
 *   ZIP Code is one address.
 */

import {
	lookupDirectional,
	lookupUSState,
	US_STREET_SUFFIX_LOOKUP,
	US_UNIT_DESIGNATOR_LOOKUP,
} from "@mailwoman/codex/us"
import { foldNFKCWhitespace, stripCombiningMarks } from "@mailwoman/normalize/fold"

import type { ParquetRow } from "#parquet/schema"

/**
 * The text and span triple an address key reads.
 */
export type AddressKeyRow = Pick<ParquetRow, "raw" | "span_starts" | "span_ends" | "span_tags">

/**
 * The street tags whose spans make up the street, in the order a row writes them.
 */
const STREET_TAGS: ReadonlySet<string> = new Set(["street_prefix", "street", "street_suffix"])

/**
 * The digits of a ZIP Code without its +4: every NAD rendering writes these, so the key compares them.
 */
const ZIP_CODE_DIGITS = 5

/**
 * Lower case, marks stripped, every run of characters other than letters and digits one space.
 */
function foldKeyText(text: string): string {
	return stripCombiningMarks(foldNFKCWhitespace(text))
		.replaceAll(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
}

/**
 * Every span's text under `tags`, joined in the row's order.
 */
function spanText(row: AddressKeyRow, tags: ReadonlySet<string>): string {
	const parts: string[] = []

	for (const [index, tag] of row.span_tags.entries()) {
		if (tags.has(tag)) {
			parts.push(row.raw.slice(row.span_starts[index], row.span_ends[index]))
		}
	}

	return parts.join(" ")
}

/**
 * One folded street or unit word in its canonical form: a directional as its USPS
 * abbreviation, a street suffix or unit designator as its Pub. 28 canonical.
 */
function canonicalWord(word: string): string {
	return (
		lookupDirectional(word)?.abbreviation.toLowerCase() ??
		US_STREET_SUFFIX_LOOKUP.get(word)?.toLowerCase() ??
		US_UNIT_DESIGNATOR_LOOKUP.get(word)?.toLowerCase() ??
		word
	)
}

function canonicalWords(text: string): string {
	const folded = foldKeyText(text)

	return folded ? folded.split(" ").map(canonicalWord).join(" ") : ""
}

/**
 * The ZIP Code span's first five digits and the house number's digits, the part of
 * the key a column scan can compute before the row is read.
 *
 * @returns null when the row has no five-digit ZIP Code or no digit in its house number.
 */
export function nadAddressBlock(row: AddressKeyRow): string | null {
	const zip = spanText(row, new Set(["postcode"]))
		.replaceAll(/\D/gu, "")
		.slice(0, ZIP_CODE_DIGITS)

	const number = spanText(row, new Set(["house_number"])).replaceAll(/\D/gu, "")

	if (zip.length !== ZIP_CODE_DIGITS || !number) return null

	return `${zip}|${number}`
}

/**
 * {@linkcode nadAddressBlock} as a DuckDB expression over a corpus file aliased `alias`.
 *
 * DuckDB counts characters by code point and the spans by UTF-16 unit, so a row holding a character
 * outside the Basic Multilingual Plane before its ZIP Code reads another block and is missed.
 */
export function nadAddressBlockSQL(alias: string): string {
	const span = (tag: string) => {
		const at = `list_position(${alias}.span_tags, '${tag}')`

		return (
			`substr(${alias}.raw, ${alias}.span_starts[${at}] + 1, ` +
			`${alias}.span_ends[${at}] - ${alias}.span_starts[${at}])`
		)
	}

	const digits = (tag: string) => `regexp_replace(coalesce(${span(tag)}, ''), '[^0-9]', '', 'g')`

	return `(left(${digits("postcode")}, 5) || '|' || ${digits("house_number")})`
}

/**
 * The address key of one NAD row, `<state>|<zip5>|<house number>|<street>|<unit>`.
 *
 * @returns null when the row lacks a state, a five-digit ZIP Code, a house number
 * or a street, because such a row identifies no single address.
 */
export function nadAddressKey(row: AddressKeyRow): string | null {
	const state = lookupUSState(spanText(row, new Set(["region"])) || null)
	const block = nadAddressBlock(row)
	const number = foldKeyText(spanText(row, new Set(["house_number"])))
	const street = canonicalWords(spanText(row, STREET_TAGS))

	if (!state || !block || !number || !street) return null

	const zip = block.slice(0, ZIP_CODE_DIGITS)
	const unit = canonicalWords(spanText(row, new Set(["unit"])))

	return `${state.toLowerCase()}|${zip}|${number}|${street}|${unit}`
}
