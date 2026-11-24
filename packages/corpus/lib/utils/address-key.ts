// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The span reads and text folding an evaluation-group address key is built from.
 *
 *   A source whose group identity holds an address key (`GROUP_ADDRESS_KEY_SOURCES`) reads its key from a
 *   row's labeled spans.
 *   Every rendering the corpus writes of one address then gives one key.
 */

import { foldNFKCWhitespace, stripCombiningMarks } from "@mailwoman/normalize/fold"

import type { ParquetRow } from "#parquet/schema"

/**
 * The text and span triple an address key reads.
 */
export type AddressKeyRow = Pick<ParquetRow, "raw" | "span_starts" | "span_ends" | "span_tags">

/**
 * Lower case, marks stripped, every run of characters other than letters and digits one space.
 */
export function foldKeyText(text: string): string {
	return stripCombiningMarks(foldNFKCWhitespace(text))
		.replaceAll(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
}

/**
 * Every span's text under `tags`, joined by a space in the row's order.
 */
export function labeledSpanText(row: AddressKeyRow, tags: ReadonlySet<string>): string {
	const parts: string[] = []

	for (const [index, tag] of row.span_tags.entries()) {
		if (tags.has(tag)) {
			parts.push(row.raw.slice(row.span_starts[index], row.span_ends[index]))
		}
	}

	return parts.join(" ")
}

/**
 * The text of the first span tagged `tag` in a corpus file aliased `alias`,
 * as a DuckDB expression, NULL when the row has none.
 *
 * DuckDB counts characters by code point and the spans by UTF-16 unit, so in a row
 * holding a character outside the Basic Multilingual Plane before the span the
 * expression reads text shifted by one per such character.
 */
export function aliasedSpanSQL(alias: string, tag: string): string {
	const at = `list_position(${alias}.span_tags, '${tag}')`

	return `substr(${alias}.raw, ${alias}.span_starts[${at}] + 1, ${alias}.span_ends[${at}] - ${alias}.span_starts[${at}])`
}
