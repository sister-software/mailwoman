// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The code-equivalence relations of one country entity: alpha-2, alpha-3
 *   and numeric codes of the same record.
 */

import { getCountryByAlpha2, getCountryByAlpha3, getCountryByNumeric } from "#iso3166/records"

/**
 * The alpha-3 code of the entity an alpha-2 code identifies, or `null`.
 */
export function alpha3ForAlpha2(alpha2: string): string | null {
	return getCountryByAlpha2(alpha2)?.alpha3 ?? null
}

/**
 * The alpha-2 code of the entity an alpha-3 code identifies, or `null`.
 */
export function alpha2ForAlpha3(alpha3: string): string | null {
	return getCountryByAlpha3(alpha3)?.alpha2 ?? null
}

/**
 * The alpha-2 code of the entity a numeric code identifies, or `null`.
 */
export function alpha2ForNumeric(numeric: string): string | null {
	return getCountryByNumeric(numeric)?.alpha2 ?? null
}
