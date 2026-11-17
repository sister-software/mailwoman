// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The words an address writes beside a county's name, per country, and the bare name they leave.
 *
 *   The resolver reads the table when no locality in the resolved region matches a span tagged `locality`:
 *   a value written with one of its country's designators is looked up as a WOF `county` there.
 */

/**
 * One country's county designators, each lower-case with internal whitespace collapsed to one space.
 */
export interface CountyDesignators {
	/**
	 * Words written after the name: `Harris County`, `Jefferson Parish`, `Petersburg Borough`.
	 */
	suffixes: readonly string[]
	/**
	 * Words written before the name: `County Cork`, `Co. Cork`.
	 */
	prefixes: readonly string[]
}

/**
 * County designators by lower-case ISO 3166-1 alpha-2 code.
 *
 * Measured against the WOF `county` and `macrocounty` rows of `candidate-global-2026-11-16.db`.
 * The table holds each country whose rows store the designator in a written alias
 * and whose addresses write it in the language WOF stores:
 *
 * - `us`: 2,856 of 3,143 county places have a `<name> county` key, 75 a `<name> parish`
 *   key (Louisiana), 16 `<name> borough` and 5 `<name> census area` (Alaska).
 * - `ca`: 63 of 1,796 have `<name> county` (37 in Alberta, 24 in Ontario, 2 in Nova Scotia).
 * - `ie`: the 31 county places have `county <name>` (26) and `co <name>` (7) keys,
 *   the order Irish addresses write.
 *   The 15 `<name> county` keys are kept as a suffix too.
 *
 * The countries left out:
 *
 * - `gb` writes `County` only inside a few proper names (`County Durham`, the Welsh
 *   `county of <name>` and `<name> county borough` forms, 22 and 10 keys of 460 places),
 *   and WOF already keys each of those whole names.
 * - `ir` (481 of 748), `pl` (314 of 543) and `kr` (86 of 250) store `<name> county`
 *   as an English rendering of the shahrestan, the powiat and the gun.
 *   Addresses there write the local word.
 * - `ee` stores `<name> parish` on 64 of 79 rows, an English rendering of `vald`.
 */
const COUNTY_DESIGNATORS: Readonly<Record<string, CountyDesignators>> = {
	us: { suffixes: ["county", "parish", "borough", "census area", "city and borough"], prefixes: [] },
	ca: { suffixes: ["county"], prefixes: [] },
	ie: { suffixes: ["county"], prefixes: ["county", "co.", "co"] },
}

/**
 * The county designators of a country given by ISO alpha-2 code in any case,
 * or `null` for a country the table doesn't cover.
 */
export function countyDesignatorsFor(countryCode: string | null | undefined): CountyDesignators | null {
	return countryCode ? (COUNTY_DESIGNATORS[countryCode.toLowerCase()] ?? null) : null
}

/**
 * The county name a written value leaves once its country's designator is removed, or `null`
 * when the value has none of that country's designators or would leave no name.
 *
 * `Harris County` in `US` returns `Harris`, `Co. Cork` in `IE` returns `Cork`, and `Harris` returns `null`.
 * The returned name keeps the value's own spelling.
 */
export function countyNameWithoutDesignator(value: string, countryCode: string | null | undefined): string | null {
	const designators = countyDesignatorsFor(countryCode)

	if (!designators) return null

	const written = value.trim().replaceAll(/\s+/g, " ")
	const lower = written.toLowerCase()

	for (const suffix of designators.suffixes) {
		if (lower.length > suffix.length + 1 && lower.endsWith(` ${suffix}`)) {
			return written.slice(0, written.length - suffix.length - 1).trim() || null
		}
	}

	for (const prefix of designators.prefixes) {
		const head = prefix.endsWith(".") ? prefix : `${prefix} `

		if (lower.length > head.length && lower.startsWith(head)) {
			return written.slice(head.length).trim() || null
		}
	}

	return null
}
