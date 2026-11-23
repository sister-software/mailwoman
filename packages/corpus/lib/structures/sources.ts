// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The official lists of structures `mailwoman gazetteer build structures` writes into `structures.db`.
 *
 *   One entry per source.
 *   A new country's list, such as a postal operator's list of its post offices, is written
 *   under `lib/<cc>/structures/` to the contract in `#structures/source` and added here.
 *
 *   A list that spans countries sits under its publisher's country, as NGA's World Port Index does
 *   under `lib/us/`, or beside this module when its publisher has no seat, as OurAirports does.
 */

import { LAPOSTE_POINCONT_STRUCTURE_SOURCES } from "#fr/structures/laposte"
import { optNCAgencesStructures } from "#nc/structures/opt-nc"
import { ourAirportsStructures } from "#structures/ourairports"
import type { StructureSource } from "#structures/source"
import { chunghwaPostStructures } from "#tw/structures/chunghwa-post"
import { ngaWorldPortIndexStructures } from "#us/structures/nga-wpi"
import { usgsNationalMapStructures } from "#us/structures/usgs/national-map"

/**
 * Every registered structure source, in the order the layer reads them.
 */
export const STRUCTURE_SOURCES: readonly StructureSource[] = [
	usgsNationalMapStructures,
	...LAPOSTE_POINCONT_STRUCTURE_SOURCES,
	optNCAgencesStructures,
	chunghwaPostStructures,
	ngaWorldPortIndexStructures,
	ourAirportsStructures,
]
