// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `zoning_area.rings` — the blob layout and point test re-exported from `@mailwoman/spatial`;
 *   `resolveRingRoles` stays local because the clockwise-exterior role encoding belongs to this publisher rather than to geometry.
 */

export { resolveRingRoles, type ResolvedRingRoles } from "#ring-roles"
