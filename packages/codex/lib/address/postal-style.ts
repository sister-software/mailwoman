// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The postal authority's own form of an address, per country: the case it prints in,
 *   the punctuation it drops, and the gap it leaves before the postcode.
 *
 *   `formatAddressRow` applies a country's entry when the caller asks for the postal form.
 */

/**
 * Upper case, lower case, or the case the components were given in.
 */
export type AddressCasing = "upper" | "lower" | null

/**
 * One postal authority's rules for printing an address.
 */
export interface PostalStyle {
	/**
	 * The case the authority prints in.
	 */
	readonly casing: AddressCasing
	/**
	 * Whether periods and commas are dropped.
	 *
	 * A hyphen, as in a ZIP+4 code, and a slash, as in `1/2`, are kept.
	 */
	readonly dropPunctuation: boolean
	/**
	 * The whitespace written before the postcode.
	 */
	readonly postcodeGap: string
	/**
	 * Where the authority states these rules.
	 */
	readonly source: string
}

/**
 * Postal styles keyed by ISO 3166-1 alpha-2 code.
 *
 * A country absent here has no recorded postal style, and its postal form is
 * its ordinary form with the caller's casing.
 */
export const POSTAL_STYLES: Readonly<Partial<Record<string, PostalStyle>>> = Object.freeze({
	US: Object.freeze({
		casing: "upper",
		dropPunctuation: true,
		postcodeGap: "  ",
		source:
			"USPS, Business Mail 101, Delivery Address (pe.usps.com/businessmail101?ViewName=DeliveryAddress): " +
			"uppercase letters, no punctuation, and two spaces between the state and the ZIP Code",
	}),
})

/**
 * Returns the postal style recorded for `country`, or null when none is recorded.
 */
export function postalStyleForCountry(country: string): PostalStyle | null {
	return POSTAL_STYLES[country.trim().toUpperCase()] ?? null
}

/**
 * Applies a casing to one value.
 */
export function applyCasing(value: string, casing: AddressCasing): string {
	if (casing === "upper") return value.toUpperCase()

	if (casing === "lower") return value.toLowerCase()

	return value
}

/**
 * Replaces every period and comma with a space and collapses the whitespace that leaves, line by line.
 */
export function dropAddressPunctuation(value: string): string {
	return value
		.replaceAll(/[.,]/g, " ")
		.replaceAll(/[ \t]+/g, " ")
		.replaceAll(/ ?\n ?/g, "\n")
		.trim()
}
