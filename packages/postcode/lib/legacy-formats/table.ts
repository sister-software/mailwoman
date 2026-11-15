// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The structural postcode formats that `@mailwoman/query-shape` reports as `knownFormats`,
 *   and the PO box leaders it recognizes, as data.
 *
 *   The `legacy-formats` family compiles from this table.
 *   The patterns are the legacy patterns and not the libaddressinput patterns of `country-formats`:
 *   `us_zip` is five digits, `uk_postcode` is a simplified form, and `jp_postcode` allows a leading 〒.
 *
 *   A table of these formats reproduces the legacy hit set.
 *   Wider recognition from every country's syntax is a separate change of behavior.
 *
 *   Each pattern is a regular-expression string with its anchors removed,
 *   because the whole-input scope anchors it.
 *   A digit is `[0-9]`, which is ASCII as the legacy `\d` is.
 *
 *   Case-insensitive patterns start with the inline flag `(?i-u)`, which folds
 *   ASCII case only, as the legacy `i` flag does.
 *
 *   The order of the rows is behavior.
 *   A token's hits come out in this order, and `locale-hint` takes the first unambiguous hit.
 */

/**
 * One structural postcode format.
 */
export interface LegacyFormatRow {
	/**
	 * The format's name, as consumers read it: `us_zip`, `us_zip4` or `<cc>_postcode`.
	 *
	 * The names follow the legacy convention, so the United Kingdom is `uk_postcode`.
	 */
	readonly format: string
	/**
	 * The ISO 3166-1 alpha-2 code of the country the format belongs to.
	 */
	readonly country: string
	/**
	 * The number of tokens the pattern covers.
	 *
	 * A two-token pattern is tested against two adjacent tokens joined by one space.
	 */
	readonly tokens: 1 | 2
	/**
	 * The pattern without anchors.
	 */
	readonly pattern: string
	/**
	 * The confidence without locale context.
	 * An ambiguous pattern scores lower.
	 */
	readonly confidence: number
	/**
	 * The `format` names of the other rows whose language this row's overlaps by design.
	 */
	readonly overlaps?: readonly string[]
}

const FIVE_DIGITS = ["us_zip", "fr_postcode", "de_postcode"] as const
const SPACED_FIVE_DIGITS = ["cz_postcode", "sk_postcode", "se_postcode", "gr_postcode"] as const

/**
 * The thirteen legacy patterns, in the legacy order.
 */
export const LEGACY_FORMATS = [
	{ format: "us_zip4", country: "US", tokens: 1, pattern: "[0-9]{5}-[0-9]{4}", confidence: 0.95 },
	{
		format: "ca_postcode",
		country: "CA",
		tokens: 1,
		pattern: "(?i-u:[A-Z][0-9][A-Z][0-9][A-Z][0-9])",
		confidence: 0.95,
	},
	{ format: "jp_postcode", country: "JP", tokens: 1, pattern: "〒?[0-9]{3}-[0-9]{4}", confidence: 0.95 },
	{
		format: "uk_postcode",
		country: "GB",
		tokens: 1,
		pattern: "(?i-u:[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2})",
		confidence: 0.9,
	},
	{ format: "nl_postcode", country: "NL", tokens: 1, pattern: "(?i-u:[0-9]{4}[A-Z]{2})", confidence: 0.9 },
	{ format: "us_zip", country: "US", tokens: 1, pattern: "[0-9]{5}", confidence: 0.6, overlaps: FIVE_DIGITS },
	{ format: "fr_postcode", country: "FR", tokens: 1, pattern: "[0-9]{5}", confidence: 0.6, overlaps: FIVE_DIGITS },
	{ format: "de_postcode", country: "DE", tokens: 1, pattern: "[0-9]{5}", confidence: 0.6, overlaps: FIVE_DIGITS },
	{
		format: "uk_postcode",
		country: "GB",
		tokens: 2,
		pattern: "(?i-u:[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2})",
		confidence: 0.9,
	},
	{
		format: "ca_postcode",
		country: "CA",
		tokens: 2,
		pattern: "(?i-u:[A-Z][0-9][A-Z] [0-9][A-Z][0-9])",
		confidence: 0.9,
	},
	{ format: "nl_postcode", country: "NL", tokens: 2, pattern: "(?i-u:[0-9]{4} [A-Z]{2})", confidence: 0.9 },
	{
		format: "cz_postcode",
		country: "CZ",
		tokens: 2,
		pattern: "[0-9]{3} [0-9]{2}",
		confidence: 0.6,
		overlaps: SPACED_FIVE_DIGITS,
	},
	{
		format: "sk_postcode",
		country: "SK",
		tokens: 2,
		pattern: "[0-9]{3} [0-9]{2}",
		confidence: 0.6,
		overlaps: SPACED_FIVE_DIGITS,
	},
	{
		format: "se_postcode",
		country: "SE",
		tokens: 2,
		pattern: "[0-9]{3} [0-9]{2}",
		confidence: 0.6,
		overlaps: SPACED_FIVE_DIGITS,
	},
	{
		format: "gr_postcode",
		country: "GR",
		tokens: 2,
		pattern: "[0-9]{3} [0-9]{2}",
		confidence: 0.6,
		overlaps: SPACED_FIVE_DIGITS,
	},
] as const satisfies readonly LegacyFormatRow[]

/**
 * The format name of a PO box, and its confidence.
 *
 * A PO box is reported by a walk over tokens and not by a pattern, so it isn't a row.
 */
export const PO_BOX = { format: "po_box", confidence: 0.85 } as const

/**
 * The tokens that lead a PO box in one language, compared without regard to ASCII case.
 */
export interface PoBoxLeaders {
	/**
	 * The language the leaders belong to, as a BCP 47 language subtag.
	 */
	readonly language: string
	readonly leaders: readonly string[]
}

/**
 * The PO box leaders of each language.
 * `bp` is French, and `casilla` and `apartado` are Spanish.
 */
export const PO_BOX_LEADERS = [
	{ language: "en", leaders: ["po", "p.o.", "p.o", "box"] },
	{ language: "fr", leaders: ["bp", "b.p.", "b.p"] },
	{ language: "es", leaders: ["casilla", "apartado"] },
] as const satisfies readonly PoBoxLeaders[]
