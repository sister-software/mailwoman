// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The words before a municipality's name that state its legal form, per country, longest first.
 *
 * NAD writes `Inc_Muni` with them (`Town of Madison`, `CITY OF WAUWATOSA`, `Charter Township of Canton`),
 * and a letter is addressed to the bare name.
 * A country without a row has no bare form derived.
 */
const MUNICIPAL_LEGAL_FORMS: Readonly<Record<string, readonly string[]>> = {
	US: ["charter township of", "township of", "borough of", "village of", "city of", "town of"],
}

/**
 * The municipality's name without its leading legal-form words, or `null` when it has none.
 *
 * The bare form keeps the publisher's case: `CITY OF WAUWATOSA` becomes `WAUWATOSA`.
 *
 * @param country The ISO 3166-1 alpha-2 code of the country whose legal-form words apply.
 */
export function bareMunicipalityName(written: string, country: string): string | null {
	const lowered = written.toLowerCase()

	for (const form of MUNICIPAL_LEGAL_FORMS[country] ?? []) {
		if (lowered.startsWith(`${form} `)) {
			const bare = written.slice(form.length).trim()

			return bare || null
		}
	}

	return null
}
