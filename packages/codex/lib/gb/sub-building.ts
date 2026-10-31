/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Royal Mail's Postcode Address File rules for the premises above a street address. A Sub
 *   Building Name such as `Flat 1` is never present on its own: a Building Name or a Building Number
 *   is always present with it. A Building Number opens the first thoroughfare line.
 *
 *   The guide names two unit designators in its examples. `Flat 1` is its example of a Sub Building
 *   Name, and `Suite 1-3` appears in an actual address as a Building Name. The guide gives no list of
 *   designators beyond these.
 *
 * @see {@link https://www.poweredbypaf.com/wp-content/uploads/2017/07/Latest-Programmers_guide_Edition-7-Version-6.pdf Royal Mail, PAF Programmers' Guide, Edition 7 Version 6}
 */

import type { PostalGuidelineCitation, PostalUnitGuidelineRule } from "#postal/guideline"

const PAF_GUIDE = {
	document: "Programmers' Guide",
	publisher: "Royal Mail",
	edition: "Edition 7 Version 6",
	url: "https://www.poweredbypaf.com/wp-content/uploads/2017/07/Latest-Programmers_guide_Edition-7-Version-6.pdf",
	sha256: "e74e47faf24de3ccf090dde9bdfed1d523ed881b6580609087f2611e2736a163",
	fetched: "2026-10-20",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription" | "section">

/**
 * The unit designators the PAF guide writes.
 */
export const GB_SUB_BUILDING_RULES: readonly PostalUnitGuidelineRule[] = [
	{
		id: "gb-paf-sub-building-flat",
		kind: "unit",
		designator: "Flat",
		abbreviation: null,
		requiresIdentifier: true,
		statement: "A flat is a Sub Building Name, written as Flat and its number.",
		citation: {
			...PAF_GUIDE,
			section: "Table 7: Address elements of PAF",
			quote: "Sub Building Name (e.g. ‘Flat 1’) 30 Yes, if applicable",
			transcription: "Three cells of one table row, joined by one space each.",
		},
	},
	{
		id: "gb-paf-building-name-suite",
		kind: "unit",
		designator: "Suite",
		abbreviation: null,
		requiresIdentifier: true,
		statement: "An actual PAF address holds Suite 1-3 in its Building Name and prints it above the thoroughfare.",
		citation: {
			...PAF_GUIDE,
			section: "Formatting a PAF address for printing, Example 5",
			quote: "Platinum Finance Suite 1-3 Station Road MUSSELBURGH EH21 7PB",
			transcription: "The printed address's lines are joined by one space each.",
		},
	},
]

/**
 * Where the PAF guide places the premises elements.
 */
export const GB_SUB_BUILDING_PLACEMENT_RULES = [
	{
		id: "gb-paf-sub-building-not-alone",
		statement: "A Sub Building Name comes with a Building Name or a Building Number.",
		citation: {
			...PAF_GUIDE,
			section: "Structure of a PAF address, Premises elements",
			quote:
				"A combination of these elements may be present, but a Sub Building Name cannot be present on its own. " +
				"When a Sub Building is present, there will always be Building Name or Building Number data present.",
			transcription: null,
		},
	},
	{
		id: "gb-paf-rule-2-building-number",
		statement: "The Building Number opens the first thoroughfare line.",
		citation: {
			...PAF_GUIDE,
			section: "Rule 2 - Building Number only",
			quote: "The Building Number should appear at the beginning of the first Thoroughfare line.",
			transcription: null,
		},
	},
] as const
