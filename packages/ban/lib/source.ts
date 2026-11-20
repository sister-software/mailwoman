// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where the Base Adresse Nationale is published, for the builder that downloads it
 *   and for a server that links a user to it.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

/**
 * Root URL for the latest BAN CSV exports.
 */
export const BAN_CSV_BASE = "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv"

/**
 * The name the BAN builds record in a manifest's `source`, before the `:<country>` scope.
 */
export const BAN_SOURCE_NAME = "ban"

/**
 * Where a user obtains each source a BAN layer records.
 */
export const BAN_SOURCE_LOCATIONS: Readonly<Record<string, SourceLocation>> = {
	[BAN_SOURCE_NAME]: { title: "Base Adresse Nationale", url: BAN_CSV_BASE },
}
