// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Checks a row's component values against its country's rules and against its own other components.
 *
 *   A row that aligns can still hold a wrong value: a postcode that's a state code (`1811 Hayes Avenue, Hull, IA IA`),
 *   a street line repeated where the city belongs (`56 East Chase Street, 56 East Chase Street, FL 32502`), or a
 *   street that ends in the row's own postcode (`655 MAPLE AVE # 90014, LOS ANGELES, CA 900142211`). Every rule reads
 *   per-country data or the row itself, so the same rules hold in every country.
 */

import { acceptPostcode, postcodeSyntax } from "@mailwoman/postcode/country-formats"

import type { CanonicalRow } from "#types"

/**
 * The rules a component value can fail, as the `<tag>:<rule>` tail of a `component-invalid` reason.
 */
export const ComponentRule = {
	/**
	 * The postcode doesn't have the form the country's postcode syntax states.
	 */
	PostcodeFormat: "postcode:format",
	/**
	 * The street ends in the row's own postcode.
	 */
	StreetRepeatsPostcode: "street:repeats-postcode",
	/**
	 * The street ends in the row's own locality and region, and its postcode where the row has one.
	 */
	StreetHoldsPlace: "street:holds-place",
	/**
	 * The locality holds the row's house number and street: the publisher filled
	 * the city with the street line.
	 */
	LocalityHoldsStreet: "locality:holds-street",
} as const

export type ComponentRule = (typeof ComponentRule)[keyof typeof ComponentRule]

/**
 * The rules a build quarantines a row for.
 *
 * `postcode:format` is reported but not enforced.
 * The v0.8.9 dry run (#2898) found 522,089 rows failing it, among them legitimate partial
 * postcodes (WOF's Dutch `3704`) and spaced written forms (`31 261` in Kraków), beside the defects
 * it is meant for (NAD's 425,667 short ZIP Codes and Overture Brazil's dropped leading zeros).
 */
export const ENFORCED_COMPONENT_RULES: ReadonlySet<ComponentRule> = new Set([
	ComponentRule.StreetRepeatsPostcode,
	ComponentRule.StreetHoldsPlace,
	ComponentRule.LocalityHoldsStreet,
])

/**
 * One rule a row fails, with the component values that fail it.
 */
export interface ComponentFinding {
	rule: ComponentRule
	values: string[]
}

/**
 * The fewest digits a street's ending needs before it is compared with the row's postcode.
 */
const SHORTEST_POSTCODE_DIGITS = 4

const fold = (text: string) =>
	text
		.normalize("NFC")
		.toLowerCase()
		.replaceAll(/[\s,.]+/gu, " ")
		.trim()

/**
 * The rules `components` fails for a row of `country`, in rule order.
 */
export function componentFindings(components: CanonicalRow["components"], country: string): ComponentFinding[] {
	const findings: ComponentFinding[] = []
	const { postcode, street, locality, region } = components

	if (postcode && postcodeSyntax(country) && acceptPostcode(postcode, country) == null) {
		findings.push({ rule: ComponentRule.PostcodeFormat, values: [postcode] })
	}

	if (street && postcode) {
		const postcodeDigits = postcode.replaceAll(/\D/gu, "")
		const tail = /(\d[\d-]*)\s*$/u.exec(street)?.[1]?.replaceAll(/\D/gu, "") ?? ""

		if (tail.length >= SHORTEST_POSTCODE_DIGITS && postcodeDigits.startsWith(tail)) {
			findings.push({ rule: ComponentRule.StreetRepeatsPostcode, values: [street, postcode] })
		}
	}

	if (street && locality && region) {
		const foldedStreet = fold(street)
		// Comparison keys over the row's own values, in the order a street line runs into them.
		const place = fold([locality, region].join(" "))
		const withPostcode = postcode ? fold([locality, region, postcode].join(" ")) : null

		if (
			foldedStreet !== place &&
			(foldedStreet.endsWith(` ${place}`) || (withPostcode != null && foldedStreet.endsWith(` ${withPostcode}`)))
		) {
			findings.push({ rule: ComponentRule.StreetHoldsPlace, values: [street, locality, region] })
		}
	}

	// A locality may share words with its street (`Fox Park CDP` for `Fox Park Road`,
	// a village whose only street has the village's name).
	// A locality that holds the row's house number and street is the street line itself
	// (`56 East Chase Street` as the city of `56 East Chase Street`).
	const houseNumber = components.house_number

	if (street && locality && houseNumber) {
		const line = fold([houseNumber, street].join(" "))

		if (` ${fold(locality)} `.includes(` ${line} `)) {
			findings.push({ rule: ComponentRule.LocalityHoldsStreet, values: [locality, houseNumber, street] })
		}
	}

	return findings
}
