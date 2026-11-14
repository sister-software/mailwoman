// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The support promises: each country and input language Mailwoman tells
 *   customers it handles, and how deep.
 *
 *   The rows live in `./support/promises.json`, so the docs site and non-TypeScript
 *   readers see the same declaration.
 *   Inside a promise's depth, a wrong parse, a miss or a missing corpus is a bug.
 *
 *   Below that depth, the result must be an explicit unresolved component rather than a guess.
 *
 *   A promise's evidence is every gauntlet case in its country whose letters are all in its input script.
 *   The repository check `support-promises` validates every code against
 *   `@mailwoman/registry`, refuses a promise whose evidence holds no passing case,
 *   and reports each failing case as an open bug against it.
 */

import declaration from "./support/promises.json" with { type: "json" }

/**
 * The components a promise can guarantee, from the deepest to the shallowest.
 */
export const SUPPORT_DEPTHS = ["address-point", "street", "postcode", "locality", "region", "country"] as const

export type SupportDepth = (typeof SUPPORT_DEPTHS)[number]

/**
 * One support promise.
 */
export interface SupportPromise {
	/**
	 * The ISO 3166-1 alpha-2 country the address is in, such as `US`.
	 */
	country: string
	/**
	 * The BCP 47 language and script of the text the user types, such as `ja-Jpan`.
	 */
	input: string
	/**
	 * ISO 15924 scripts allowed in a name span, such as a restaurant's name,
	 * inside an otherwise `input`-script address.
	 */
	embeddedNameScripts: readonly string[]
	/**
	 * The deepest component the promise guarantees.
	 */
	depth: SupportDepth
}

/**
 * Every support promise, in declaration order.
 */
export const SUPPORT_PROMISES = declaration.promises as readonly SupportPromise[]

/**
 * The promises for addresses in one country.
 */
export function supportPromisesFor(country: string): SupportPromise[] {
	return SUPPORT_PROMISES.filter((promise) => promise.country === country)
}
