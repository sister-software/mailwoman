// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where OpenAddresses publishes its runs, for the fetcher that downloads them,
 *   for a layer build that records them and for a reader that links a user to them.
 */

import type { SourceLocation } from "@mailwoman/core/resolver"

/**
 * The OpenAddresses batch service.
 *
 * It serves each source's latest run and the country collections.
 *
 * Downloads require a free registered account.
 */
export const OPENADDRESSES_BATCH_URL = "https://batch.openaddresses.io"

/**
 * The name a layer build records in a manifest's `source` for OpenAddresses, before the `:<run>` scope.
 */
export const OPENADDRESSES_SOURCE_NAME = "openaddresses"

/**
 * Where a user obtains each OpenAddresses run.
 */
export const OPENADDRESSES_SOURCE_LOCATIONS: Readonly<Record<string, SourceLocation>> = {
	[OPENADDRESSES_SOURCE_NAME]: { title: "OpenAddresses", url: OPENADDRESSES_BATCH_URL },
}
