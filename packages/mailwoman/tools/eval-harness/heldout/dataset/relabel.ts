// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Answer-key revisions a held-out collection can be revised under (`reviseHeldoutDataset`).
 *
 *   Each revision is one decision applied to every row it covers, with an id a revised manifest records.
 */

import { countyNameWithoutDesignator } from "@mailwoman/codex/county-designators"

import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

/**
 * A revision: its recorded rule, the annotation suffix of a changed row, and the row function.
 */
export interface HeldoutRelabel {
	id: string
	rule: string
	revise: (row: HeldoutRow) => HeldoutRow
}

/**
 * The 2026-11-17 county decision: a `locality` span written with its country's county designator
 * (`Carter County` in US, `Co Dublin` in IE, from the codex `county-designators` table)
 * is the county written in the town position, so its expected tag is `subregion`,
 * the tag the codex maps to a WOF county.
 */
export const COUNTY_IN_LOCALITY_SLOT: HeldoutRelabel = {
	id: "county-in-locality-slot-subregion",
	rule:
		"Operator decision 2026-11-17: a county written in the town position is subregion. Every expected locality " +
		"span whose text carries its row country's county designator (codex county-designators: US, CA, IE) is " +
		"relabeled subregion; no other span changes.",
	revise: (row) => {
		let changed = false

		const tags = row.span_tags.map((tag, i) => {
			if (tag !== "locality") return tag

			const text = row.raw.slice(row.span_starts[i], row.span_ends[i])

			if (countyNameWithoutDesignator(text, row.country) == null) return tag

			changed = true

			return "subregion"
		})

		return changed ? { ...row, span_tags: tags } : row
	},
}
