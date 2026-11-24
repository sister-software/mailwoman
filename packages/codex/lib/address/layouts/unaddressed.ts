// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The jurisdictions whose postal addressing description states they have no permanent population.
 *
 * libaddressinput states a `fmt` for some of these codes.
 * A layout read from it would print an address no postal operator delivers to.
 *
 * `layoutForCountry` therefore answers `null` for each code here, and the
 * layout generator writes no entry for it.
 *
 * Each entry cites the page that states the place has no permanent population.
 */

import type { LayoutCitation } from "#address/convention-claims"
import { upuDescription } from "#address/layouts/citations/upu-description"

/**
 * Citations by ISO 3166-1 alpha-2.
 */
export const UNADDRESSED_JURISDICTIONS: Readonly<Record<string, LayoutCitation>> = {
	HM: upuDescription(
		"hmd",
		"2004-9",
		"481e6f38dadbb55d589f3f21197e5b1ef8d67da96d669fa395743ca1b521db2c",
		[["Heard Island and McDonald Islands", "Australian External Territory", "Uninhabited"]],
		[]
	),
	UM: upuDescription(
		"umi",
		"2005-3",
		"b26bffe467531aca6e84d20ca42376a3d6fbbb3e2ba2875341534c0cca4c1920",
		[
			[
				"Minor Outying Islands follow the United States of America postal system. Its state code",
				"is UM. There is no permanent population.",
			],
		],
		[]
	),
}
