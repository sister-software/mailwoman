// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The citation of one UPU Postal Addressing Systems description, the form every citation
 * table in `#address/layouts/citations` and every description record builds on.
 */

import { ConventionSource, type LayoutCitation } from "#address/convention-claims"

/**
 * The date every description was retrieved and hashed.
 */
export const RETRIEVED_AT = "2026-11-24"

/**
 * A citation of the UPU Postal Addressing Systems description filed under `iso3`.
 */
export function upuDescription(
	iso3: string,
	documentDate: string,
	sha256: string,
	examples: readonly (readonly string[])[],
	unexpressed: readonly string[]
): LayoutCitation {
	return {
		source: ConventionSource.PostalAddressingSystems,
		url: `https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/${iso3}En.pdf`,
		documentDate,
		retrievedAt: RETRIEVED_AT,
		sha256,
		examples,
		unexpressed,
	}
}
