/**
 * @copyright Sister Software
 */

import { FSA_LETTER_TO_PROVINCE } from "@mailwoman/codex/ca"
import { US_PO_BOX_DESIGNATORS } from "@mailwoman/codex/us"

import { PO_BOX_LOCALE_TEMPLATES, type LocaleTemplate } from "#synthesizers/po-box"

const templates: Record<string, LocaleTemplate> = Object.fromEntries(
	PO_BOX_LOCALE_TEMPLATES.map((template) => [template.locale, template])
)

/**
 * Common US PO-box leaders from the en-US corpus template.
 */
export const US_LEADERS_COMMON = templates["en-US"]!.leaders

/**
 * Less-common USPS designators derived from the codex list.
 */
export const US_LEADERS_RARE = US_PO_BOX_DESIGNATORS.filter(
	(designator) => !["POST OFFICE BOX", "PO BOX", "P O BOX", "BOX"].includes(designator)
).map((designator) =>
	designator
		.toLowerCase()
		.split(" ")
		.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
		.join(" ")
)

/**
 * US private-mailbox leaders excluding the conflicting hash sign.
 */
export const US_PMB_LEADERS = templates["en-US"]!.pmb!.filter((leader) => leader !== "#")
/**
 * French PO-box leaders from the fr-FR corpus template.
 */
export const FR_LEADERS = templates["fr-FR"]!.leaders
/**
 * French-language Canadian PO-box leaders from the fr-CA template.
 */
export const CA_FR_LEADERS = templates["fr-CA"]!.leaders
/**
 * English-language Canadian PO-box leaders from the en-CA template.
 */
export const CA_EN_LEADERS = templates["en-CA"]!.leaders
/**
 * Current Australian delivery-service leaders.
 */
export const AU_LEADERS_CURRENT = ["PO Box", "P.O. Box", "Post Office Box", "GPO Box", "Locked Bag", "Private Bag"]
/**
 * Recognized legacy Australian delivery-service leaders.
 */
export const AU_LEADERS_LEGACY = ["RMB", "RSD", "CMB"]
/**
 * Common New Zealand delivery-service leaders.
 */
export const NZ_LEADERS_COMMON = ["PO Box", "Private Bag"]
/**
 * Rare New Zealand delivery-service leader.
 */
export const NZ_LEADERS_RARE = ["CMB"]

/**
 * Quebec first-letter choices from the Canadian FSA prior.
 */
export const QC_FSA_LETTERS = Object.entries(FSA_LETTER_TO_PROVINCE)
	.filter(([, province]) => province === "QC")
	.map(([letter]) => letter)

/**
 * Ontario first-letter choices from the Canadian FSA prior.
 */
export const ON_FSA_LETTERS = Object.entries(FSA_LETTER_TO_PROVINCE)
	.filter(([, province]) => province === "ON")
	.map(([letter]) => letter)

/**
 * Valid Canadian postal-code interior letters.
 */
export const CA_INTERIOR_LETTERS = "ABCEGHJKLMNPRSTVWXYZ"

/**
 * Weighted country and address-form mix for generated rows.
 */
export const CLASS_MIX: ReadonlyArray<[string, number]> = [
	["po-box-us", 0.27],
	["po-box-us-military", 0.05],
	["pmb-us", 0.07],
	["bp-fr", 0.1],
	["cedex-fr", 0.17],
	["cp-ca-fr", 0.12],
	["po-box-ca-en", 0.04],
	["po-box-au", 0.12],
	["po-box-nz", 0.06],
]

/**
 * English recipient prefixes used in venue layouts.
 */
export const VENUES_EN = ["John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Maria Garcia", "Riverside Clinic"]
/**
 * French recipient prefixes used in venue layouts.
 */
export const VENUES_FR = ["Société Dupont", "Cabinet Martin", "Hôpital Central", "Mairie Annexe", "Imprimerie Moderne"]
