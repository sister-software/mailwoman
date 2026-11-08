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
	// The Migration and Citizenship Service of the Ministry of Internal Affairs gives
	// its Department for Citizenship as `17/10, 4th District, Davtashen, Yerevan`
	// (migration.mia.gov.am/en/grounds-for-granting-ra-citizenship-1).
	AM: "Ministry of Internal Affairs office address in a numbered district of Davtashen",
	// UPU, Postal addressing systems in member countries: Belarus (07/2018), village delivery:
	// `d. Prosti, d.318` (locality + premises) under `p/o Ostrovki`, with no street.
	BY: "UPU addressing summary, Belarus (07/2018)",
	// Markt Metten, Satzung über Straßennamen und die Nummerierung der Gebäude
	// (1965, Arbeitsfassung 1.12.2015), § 1 (1): `Die Gebäude werden nach Straßen und Ortsteilen nummeriert.`
	DE: "Markt Metten house-numbering statute, § 1 (1)",
	// Georgian Post, `Addresses of contractors' offices` (2025): `Building 7, 6th micro district,
	// Gldani` and `Building A, I block, III array, Varketili`, both in Tbilisi with no street.
	GE: "Georgian Post contractor office list (2025)",
	// UPU, Postal addressing systems in member countries: Kyrgyzstan (03/2019):
	// `microdistrict 7, house 23` (sub-locality + house number) under `720028 BISHKEK`.
	KG: "UPU addressing summary, Kyrgyzstan (03/2019)",
	// Rules for addressing real estate objects, order № 217 and № 230/НҚ of 30 April 2026
	// (Ministry of Justice registration № 38643), para. 14: the street is written only
	// `При наличии в поселениях улиц`; para. 45 adds the microdistrict name to an object inside it.
	KZ: "Rules for addressing real estate objects (2026), paras. 14 and 45",
	// UPU, Postal addressing systems in member countries: Madagascar (08/2011):
	// `Lot 386 Cité Ambohimpo` (house no. + district) and `Lot 67 Parcelle 1139 / Ankirihiry North`.
	MG: "UPU addressing summary, Madagascar (08/2011)",
	// UPU, Postal addressing systems in member countries: Malaysia (02/2010), under `Non street address`:
	// `20, Kampung Masjid` (house number, village name) above `34500 Batu Kurau`.
	MY: "UPU addressing summary, Malaysia (02/2010)",
	// Parcelles Assainies, a Dakar commune, is divided into numbered Unités, and its addresses
	// are written `Unité 8, villa 317, Parcelles Assainies, Dakar`: the commune's description on
	// senegal-online.com, OpenStreetMap's tagging of the commune's houses, and its property listings.
	// The UPU Senegal summary (02/2015) shows street addresses only.
	SN: "Parcelles Assainies Unité numbering (senegal-online.com; OpenStreetMap)",
	// UPU, Postal addressing systems in member countries: Turkmenistan (12/2020),
	// regional home delivery: `j. 19 otag 1` (building and apartment) under `kv. 122`
	// (block) and `sh. BALKANABAT`, with no street.
	// UPU, Postal addressing systems in member countries: Thailand (09/2017), rural address:
	// `151 Moo 4, Tambon Paikongdin` (street number + village, sub-district), with no street.
	TH: "UPU addressing summary, Thailand (09/2017)",
	TM: "UPU addressing summary, Turkmenistan (12/2020)",
	// Law of Ukraine on Regulation of Urban Development Activity, Art. 26-3 part 4, lists the street
	// among an address's requisites `(за наявності)`, before `номер об’єкта (будинку, будівлі, споруди)`.
	UA: "Law on Regulation of Urban Development Activity, Art. 26-3 part 4",
	// UPU, Postal addressing systems in member countries: Uzbekistan (07/2019):
	// `Chilanzar block 11, 2, kv. 38` (building + premises) and `Kvartal 11, d. 5, kv. 16`.
	UZ: "UPU addressing summary, Uzbekistan (07/2019)",
}

/**
 * Whether a country's addresses number a building inside a settlement that has no street.
 *
 * Only a country with a cited source is listed. #2880 records, for each country whose held-out
 * suite rows show the form, the source that admitted it or the documents that did not show it.
 */
export function numbersHousesInSettlements(country: string | null | undefined): boolean {
	return typeof country === "string" && Object.hasOwn(CITED_SETTLEMENT_HOUSE_NUMBER_COUNTRIES, country.toUpperCase())
}
