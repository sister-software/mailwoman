/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The countries whose addresses number a building inside a settlement, estate, block or neighborhood that has no
 *   street, so a house number in a parse with no street belongs under the dependent locality or the locality.
 *
 *   The address tree's containment rule reads this table. Outside these countries a house number's only parents are
 *   a street and a `locality_unit`, and a number with neither stays a root.
 */

import type { ComponentTag } from "#component"

/**
 * The parents a listed country's house number may attach to after a street
 * and a `locality_unit`, most preferred first.
 */
export const SETTLEMENT_HOUSE_NUMBER_PARENTS: readonly ComponentTag[] = ["dependent_locality", "locality"]

/**
 * The countries a published source shows the form for, each with its source.
 */
export const CITED_SETTLEMENT_HOUSE_NUMBER_COUNTRIES: Readonly<Record<string, string>> = {
	// Parcelles Assainies, a Dakar commune, is divided into numbered Unités, and its addresses
	// are written `Unité 8, villa 317, Parcelles Assainies, Dakar`: the commune's description on
	// senegal-online.com, OpenStreetMap's tagging of the commune's houses, and its property listings.
	// The UPU Senegal summary (02/2015) shows street addresses only.
	SN: "Parcelles Assainies Unité numbering (senegal-online.com; OpenStreetMap)",
	// UPU, Postal addressing systems in member countries: Turkmenistan (12/2020),
	// regional home delivery: `j. 19 otag 1` (building and apartment) under `kv. 122`
	// (block) and `sh. BALKANABAT`, with no street.
	TM: "UPU addressing summary, Turkmenistan (12/2020)",
}

/**
 * Whether a country's addresses number a building inside a settlement that has no street.
 *
 * Only a country with a cited source is listed. #2880 holds the countries whose held-out
 * suite rows show the form without a source yet, and each joins the table with its citation.
 */
export function numbersHousesInSettlements(country: string | null | undefined): boolean {
	return typeof country === "string" && Object.hasOwn(CITED_SETTLEMENT_HOUSE_NUMBER_COUNTRIES, country.toUpperCase())
}
