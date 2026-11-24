// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The groups a country's postal operator writes its postcode in, for each country that has a rule.
 *
 *   A source may store a postcode without the space its operator prints (`38473`, `4524JH`, `K7K6R2`).
 *   A row rendered from that value teaches a form no envelope shows, so a renderer writes
 *   the operator's form with {@linkcode writtenPostcode} before it places the postcode.
 *
 *   Each rule cites the operator's description in the UPU's Postal Addressing Systems series.
 */

/**
 * One country's written postcode: the shape of the compact code and where the separator goes.
 */
interface PostcodeWrittenGroups {
	/**
	 * The whole compact code, upper-cased and without white space.
	 */
	readonly compact: RegExp
	/**
	 * The count of characters before the separator.
	 */
	readonly splitAt: number
	/**
	 * What the operator prints between the two groups.
	 */
	readonly separator: string
}

/**
 * The written groups of each country that has a rule, keyed by ISO 3166-1 alpha-2 code.
 */
const POSTCODE_WRITTEN_GROUPS: Readonly<Record<string, PostcodeWrittenGroups>> = {
	// UPU, Canada (09/2014): `6 alphanumeric characters (ANA NAN) to the right of the province,
	// with a space between the 3rd and 4th characters`, as in `MONTREAL QC H3Z 2Y7`.
	CA: { compact: /^[A-Z]\d[A-Z]\d[A-Z]\d$/u, splitAt: 3, separator: " " },
	// UPU, Czech Rep. (02/2018): `5 digits to the left of locality name; 1 space between 3rd
	// and 4th digits`, as in `102 00 Praha 102`.
	CZ: { compact: /^\d{5}$/u, splitAt: 3, separator: " " },
	// UPU, Netherlands (05/2016): `A space shall be printed between the numerical part of the
	// postcode and the alphabetical part`, as in `6832 AM  ARNHEM`.
	NL: { compact: /^[1-9]\d{3}[A-Z]{2}$/u, splitAt: 4, separator: " " },
	// UPU, Slovakia (01/2013): `5 digits to the left of the locality name, a space between the
	// 3rd and 4th digits`, as in `010 01 ŽILINA`.
	SK: { compact: /^\d{5}$/u, splitAt: 3, separator: " " },
}

/**
 * Returns `value` in the groups `country`'s operator writes, or `value` trimmed
 * when the country has no rule or the value isn't one whole code of the rule's shape.
 *
 * @param country An ISO 3166-1 alpha-2 code in either case.
 */
export function writtenPostcode(value: string, country: string): string {
	const trimmed = value.trim()
	const code = country.toUpperCase()
	const rule = Object.hasOwn(POSTCODE_WRITTEN_GROUPS, code) ? POSTCODE_WRITTEN_GROUPS[code] : null

	if (!rule) return trimmed

	const compact = trimmed.replaceAll(/\s+/gu, "").toUpperCase()

	if (!rule.compact.test(compact)) return trimmed

	return `${compact.slice(0, rule.splitAt)}${rule.separator}${compact.slice(rule.splitAt)}`
}
