// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { RegionName } from "./names.ts"

/**
 * M.49 region codes for continents.
 */
export const RegionCodes = [
	// ---
	"AF",
	"AN",
	"AS",
	"EU",
	"NA",
	"OC",
	"SA",
] as const satisfies readonly string[]

/**
 * M.49 region code for a specific continent.
 *
 * @public
 */
export type RegionCode = (typeof RegionCodes)[number]

/**
 * Continent codes to their full names.
 *
 * @internal
 */
export const RegionCodeToNameRecord = {
	AF: "Africa",
	AN: "Antarctica",
	AS: "Asia",
	EU: "Europe",
	NA: "North America",
	OC: "Oceania",
	SA: "South America",
} as const satisfies Record<RegionCode, RegionName>
