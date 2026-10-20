/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australia Post's sub-unit (flat/unit) types, from the barcode booklet's FLAT/UNIT TYPE table, and
 *   its rules for writing them. A sub-unit type takes a number and is written before the street
 *   number (`Suite 3 18 Jones St`). Flat, Unit, Apartment and the slash are interchangeable, so
 *   `2/100 Smith St` is flat or unit 2 at 100 Smith St. The slash never writes a floor or level, and
 *   the dash never writes a flat, unit, floor or level number.
 *
 *   Floor and level types are `AU_LEVEL_DESIGNATORS`, from AS 4590.1.
 *
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf Australia Post barcode addressing booklet (FLAT/UNIT TYPE table)}
 */

import { AU_HINTS_AND_TIPS_CITATION } from "#au/delivery-guideline"
import type { PostalUnitGuidelineRule } from "#postal-guideline"

const SUB_UNIT_SECTION = "Undertaking analysis of unmatched addresses, Sub-unit (Flat/Unit Type)"

const TABLE_TRANSCRIPTION =
	"One row of the FLAT/UNIT TYPE table, its two cells joined by one space. The booklet sets the table " +
	"beside running text, so the extracted rows alternate with that text."

/**
 * The FLAT/UNIT TYPE table's rows, as the booklet prints them.
 */
const FLAT_UNIT_TYPES = [
	["APARTMENT", "APT"],
	["FACTORY", "FY"],
	["FLAT", "F"],
	["HOUSE", "HSE"],
	["OFFICE", "OFF"],
	["PENTHOUSE", "PTHS"],
	["ROOM", "RM"],
	["SHOP", "SHOP"],
	["STUDIO", "STU"],
	["SUITE", "SE"],
	["TOWNHOUSE", "TNHS"],
	["UNIT", "U"],
	["WAREHOUSE", "WE"],
] as const

/**
 * One cited rule per Australia Post sub-unit type.
 */
export const AU_UNIT_TYPE_RULES: readonly PostalUnitGuidelineRule[] = FLAT_UNIT_TYPES.map(
	([designator, abbreviation]) => ({
		id: `au-unit-type-${designator.toLowerCase()}`,
		kind: "unit",
		designator,
		abbreviation,
		requiresIdentifier: true,
		statement: `${designator} is a sub-unit type, abbreviated ${abbreviation}, written with its number before the street number.`,
		citation: {
			...AU_HINTS_AND_TIPS_CITATION,
			section: `${SUB_UNIT_SECTION}, FLAT/UNIT TYPE table`,
			quote: `${designator} ${abbreviation}`,
			transcription: TABLE_TRANSCRIPTION,
		},
	})
)

/**
 * How Australia Post writes a sub-unit with its number.
 */
export const AU_UNIT_PLACEMENT_RULES = [
	{
		id: "au-sub-unit-type-and-number",
		statement: "A sub-unit is written as its type and number before the street number and name.",
		citation: {
			...AU_HINTS_AND_TIPS_CITATION,
			section: SUB_UNIT_SECTION,
			quote:
				"Some addresses, such as Flat, Office, Suite, Shop, require a Sub-unit Type and Number, e.g. Suite 3 18 Jones St.",
			transcription: null,
		},
	},
	{
		id: "au-sub-unit-slash",
		statement: "A slash between two numbers writes a flat or unit number and the street number, and nothing else.",
		citation: {
			...AU_HINTS_AND_TIPS_CITATION,
			section: `${SUB_UNIT_SECTION}, Correct use of symbols`,
			quote: "Level, e.g. 2/100 Smith St can only be used for Flat or Unit 2/100 Smith St.",
			transcription: null,
		},
	},
	{
		id: "au-sub-unit-interchangeable",
		statement: "Flat, Unit, Apartment and the slash are interchangeable; every other sub-unit type is distinct.",
		citation: {
			...AU_HINTS_AND_TIPS_CITATION,
			section: SUB_UNIT_SECTION,
			quote: "Flat, Unit, Apartment and ‘/ ’ are considered interchangeable.",
			transcription: null,
		},
	},
] as const
