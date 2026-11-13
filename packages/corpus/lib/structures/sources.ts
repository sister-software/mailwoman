// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The official lists of structures `mailwoman gazetteer build structures` folds into `structures.db`.
 *
 *   One entry per source.
 *   A new country's list, such as a postal operator's list of its post offices, is written
 *   under `lib/<cc>/structures/` to the contract in `#structures/source` and added here.
 */

import type { StructureSource } from "#structures/source"
import { usgsNationalMapStructures } from "#us/structures/usgs-national-map"

/**
 * Every registered structure source, in the order the layer reads them.
 */
export const STRUCTURE_SOURCES: readonly StructureSource[] = [usgsNationalMapStructures]
