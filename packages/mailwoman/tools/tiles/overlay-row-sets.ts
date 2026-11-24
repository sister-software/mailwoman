// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The row sets an overlay tile build can publish, one tile set each.
 *
 *   This module imports only core's argument and error helpers, so the release-kit
 *   launch reads the list without loading the build.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"

/**
 * The row sets that each get a tile set, in build order.
 * The gazetteer export reads the `wof` export's boundaries.
 */
export const OVERLAY_ROW_SETS = ["wof", "gazetteer"] as const

export type OverlayRowSet = (typeof OVERLAY_ROW_SETS)[number]

function isOverlayRowSet(value: string): value is OverlayRowSet {
	return OVERLAY_ROW_SETS.some((rowSet) => rowSet === value)
}

/**
 * The row sets a comma-separated list selects.
 *
 * @throws When the list holds a row set outside {@linkcode OVERLAY_ROW_SETS} or selects none.
 */
export function parseOverlayRowSets(list: string): OverlayRowSet[] {
	const entries = extractDelimited(list)
	const rowSets = entries.filter(isOverlayRowSet)

	if (!rowSets.length || rowSets.length !== entries.length) {
		throw new CommandError(`--rowsets takes ${OVERLAY_ROW_SETS.join(" and ")}, but was given "${list}"`)
	}

	return rowSets
}
