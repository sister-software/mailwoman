// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The description records the MO–ZW review of 2026-11-24 added, one per layout
 * it wrote into `UPU_PAS_ADDRESS_LAYOUTS`.
 *
 * `UPU_PAS_LAYOUT_RECORDS` in `#address/layouts/description-records` holds them beside the rest.
 */

import { upuDescription } from "#address/layouts/citations/upu-description"
import { described, UPUAdmission, type UPUPostalAddressingRecord } from "#address/layouts/upu-pas"

/**
 * Records by ISO 3166-1 alpha-2.
 */
export const MO_ZW_DESCRIPTION_RECORDS: Readonly<Record<string, UPUPostalAddressingRecord>> = {
	VA: described(
		UPUAdmission.FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"vat",
			"2005-3",
			"a46164abe5f29d01b1ec5f2367f3a4c70da3c23b974f67c7902f29dae4f64531",
			[
				["Rev. MARIO ROSSI", "Palazzo San Calisto", "Piazza San Calisto", "00120 Città del Vaticano", "VATICAN"],
				["The Vatican uses an address format identical to that of Italy, except the province"],
			],
			[
				"Italy's description (`itaEn.pdf`, 04/2020, sha256 aaa8365d42cb714f18cf9f53b0848f7b0879a3d759aa67c89aea8697cb130650), whose format the page adopts, states `Indicate the street number after the street name, never before.` (`VIALE EUROPA 22`); libaddressinput's street order printed the number first",
			]
		)
	),
}
