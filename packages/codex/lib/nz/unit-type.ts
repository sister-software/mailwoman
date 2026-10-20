/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NZ Post's Unit Type element from ADV358, and where the unit is written. The Unit line sits below
 *   the recipient and above the delivery (street) line, and opens with the Unit Type followed by the
 *   Unit Identifier. A Unit Identifier written on the delivery line instead goes before the street
 *   number with a slash (`2/153 Grange Road`).
 *
 *   The Unit Type is spelt in full where possible. `Flat` and `Unit` have no shorter form.
 *
 * @see {@link https://www.nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf NZ Post Address Standards (ADV358, June 2011)}
 */

import type { PostalGuidelineCitation, PostalUnitGuidelineRule } from "#postal-guideline"

const ADV_358 = {
	document: "Address Standards",
	publisher: "New Zealand Post",
	edition: "ADV 358DF11 June 2011",
	url: "https://www.nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf",
	sha256: "a5b09205190f388db490750d4d392aaf2ed9f2c31b6162b4cc7c8fab75639492",
	fetched: "2026-10-20",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription" | "section">

const UNIT_TYPE_SECTION = "3-D Unit Type Element, Presentation"

/**
 * The Unit Type abbreviation list, as ADV358 prints it.
 */
const UNIT_TYPES = [
	["Apartment", "Apt"],
	["Kiosk", "Ksk"],
	["Room", "Rm"],
	["Shop", "Shp"],
	["Suite", "Ste"],
	["Villa", "Vlla"],
	["Flat", "Flat"],
	["Unit", "Unit"],
] as const

/**
 * One cited rule per ADV358 Unit Type.
 */
export const NZ_UNIT_TYPE_RULES: readonly PostalUnitGuidelineRule[] = UNIT_TYPES.map(([designator, abbreviation]) => ({
	id: `nz-unit-type-${designator.toLowerCase()}`,
	kind: "unit",
	designator,
	abbreviation: abbreviation === designator ? null : abbreviation,
	requiresIdentifier: true,
	statement:
		abbreviation === designator
			? `${designator} is a Unit Type with no abbreviation, written before the Unit Identifier.`
			: `${designator} is a Unit Type, abbreviated ${abbreviation}, written before the Unit Identifier.`,
	citation: {
		...ADV_358,
		section: UNIT_TYPE_SECTION,
		quote: `${designator} ${abbreviation}`,
		transcription: "One row of the Word and Abbreviation list, its two cells joined by one space.",
	},
}))

/**
 * Where ADV358 places the unit.
 */
export const NZ_UNIT_PLACEMENT_RULES = [
	{
		id: "nz-unit-line-position",
		statement: "The Unit line is below the recipient and above the delivery line.",
		citation: {
			...ADV_358,
			section: "3-D Unit line, Placement of unit line",
			quote: "The Unit line is always below the Recipient line(s) and above the Delivery line.",
			transcription: null,
		},
	},
	{
		id: "nz-unit-type-leads",
		statement: "A Unit Type opens the Unit line and the Unit Identifier follows it.",
		citation: {
			...ADV_358,
			section: "3-D Unit Type Element, Position within address",
			quote:
				"If the Unit Type is used it must be located at the beginning of the Unit line, followed by the Unit " +
				"Identifier.",
			transcription:
				"The page sets the row label `Position within address` in a margin column, so the extracted text has " +
				"`address` between `followed` and `by`; the label word is left out.",
		},
	},
	{
		id: "nz-unit-identifier-slash",
		statement: "A Unit Identifier on the delivery line goes before the street number with a slash.",
		citation: {
			...ADV_358,
			section: "3-D Delivery line, Unit Identifier",
			quote: "E.g. 2/153 Grange Road, A/123A Jones Street.",
			transcription: null,
		},
	},
] as const
