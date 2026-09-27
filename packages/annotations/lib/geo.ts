// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The geocoder resolution tier that produced a coordinate, matching `GeocodeResult.resolution_tier`.
 */
export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin" | "venue" | "plus_code"
