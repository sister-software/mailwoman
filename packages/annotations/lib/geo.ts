// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Every geocoder resolution tier, most precise first.
 */
export const RESOLUTION_TIERS = [
	"address_point",
	"interpolated",
	"street",
	"postcode",
	"admin",
	"venue",
	"plus_code",
] as const

/**
 * The geocoder resolution tier that produced a coordinate, matching `GeocodeResult.resolution_tier`.
 */
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number]
