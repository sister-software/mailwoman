// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A list of geographic regions, i.e. continents.
 *
 * @category Geographic
 */
export const RegionNames = [
	"Africa",
	"Antarctica",
	"Asia",
	"Europe",
	"North America",
	"Oceania",
	"South America",
] as const satisfies readonly string[]

/**
 * A region of the world, i.e. a continent.
 *
 * @category Geographic
 * @title Geographic Region
 * @public
 */
export type RegionName = (typeof RegionNames)[number]
