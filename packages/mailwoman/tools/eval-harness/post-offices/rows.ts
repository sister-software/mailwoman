// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Turns the official post-office lists' records into parse-suite rows.
 *
 *   Each record with an address yields up to two rows.
 *   The `address` form is the single-line address as the record's country formats
 *   it (`formatAddressRow` with `singleLine`).
 *
 *   The `venue-address` form prefixes the post office's name as a venue.
 *   A row's expected spans are the corpus aligner's alignment of those components onto
 *   the text, the same annotation the OpenStreetMap suites store, so a row is a held-out
 *   row the existing dataset manifest freezes and the existing readers read.
 *
 *   The module holds no rule for any one country.
 *   The codex supplies the format and street convention from the record's country code.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import type { ComponentTag } from "@mailwoman/codex/component"
import type { StructureProvenance, StructureRecord, StructureSource } from "@mailwoman/corpus/structures/source"
import { alignRow } from "@mailwoman/corpus/utils/align"

import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

/**
 * The two forms a post office is written in.
 */
export const PostOfficeSuiteForm = {
	/**
	 * The address with no venue name.
	 */
	Address: "address",
	/**
	 * The post office's name, then its address.
	 */
	VenueAddress: "venue-address",
} as const

export type PostOfficeSuiteForm = (typeof PostOfficeSuiteForm)[keyof typeof PostOfficeSuiteForm]

/**
 * One suite row: a held-out row, its form, its source's provenance class,
 * and the components it was rendered from.
 */
export interface PostOfficeSuiteRow extends HeldoutRow {
	form: PostOfficeSuiteForm
	provenance: StructureProvenance
	/**
	 * The components the parser is expected to return, as the formatter rendered them.
	 */
	expected: Partial<Record<ComponentTag, string>>
}

/**
 * Why a record yields no row, counted per reason.
 */
export type PostOfficeSuiteTally = Record<string, number>

/**
 * The suite rows of one record, or none with the reason counted in `tally`.
 */
export function postOfficeSuiteRows(
	source: Pick<StructureSource, "id" | "country" | "license" | "provenance">,
	record: StructureRecord,
	tally: PostOfficeSuiteTally
): PostOfficeSuiteRow[] {
	const count = (reason: string) => {
		tally[reason] = (tally[reason] ?? 0) + 1
	}

	count("records")

	if (!record.address) {
		count("record:no-address")

		return []
	}

	const forms: Array<[PostOfficeSuiteForm, Partial<Record<ComponentTag, string>>]> = [
		[PostOfficeSuiteForm.Address, { ...record.address }],
	]

	if (record.name) {
		// `venue` first, so alignment claims its span before `locality` searches for its own.
		forms.push([PostOfficeSuiteForm.VenueAddress, { venue: record.name, ...record.address }])
	} else {
		count("record:no-name")
	}

	const rows: PostOfficeSuiteRow[] = []

	for (const [form, components] of forms) {
		const rendered = formatAddressRow(components, source.country, { singleLine: true })

		if (!rendered) {
			count(`${form}:render-failed`)

			continue
		}

		const sourceID = `${record.id}#${form}`

		const aligned = alignRow({
			raw: rendered.raw,
			components: rendered.components,
			country: source.country,
			source: source.id,
			source_id: sourceID,
			license: source.license,
		})

		if (aligned.kind !== "labeled") {
			count(`${form}:align-${aligned.row.reason}`)

			continue
		}

		const { span_starts: starts, span_ends: ends, span_tags: tags } = aligned.row

		// A labeled row always holds its span triple.
		// A row without one is a fault of the aligner.
		if (!starts || !ends || !tags) throw new Error(`the aligner labeled ${sourceID} without its span triple`)

		rows.push({
			raw: aligned.row.raw,
			span_starts: [...starts],
			span_ends: [...ends],
			span_tags: [...tags],
			country: source.country,
			source: source.id,
			source_id: sourceID,
			// The record's forms resample together.
			group: record.id,
			form,
			provenance: source.provenance,
			expected: rendered.components,
		})

		count(`${form}:rows`)
	}

	return rows
}
