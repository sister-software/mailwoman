/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   La Poste's line 2 and line 3 designators for an individual's address. Line 2 holds what is
 *   inside the building (the flat number or letter box, the floor, the corridor, the staircase) and
 *   line 3 what is outside it (the entrance, the building, the block, the tower, the residence, the
 *   housing estate). Line 4 is the number and street, and line 6 the postcode and locality.
 *
 *   The document's example writes `Appartement 2` on line 2 and `ENTREE A BATIMENT JONQUILLE` on line
 *   3, so the flat, entrance and building designators are shown with an identifier after them. The
 *   document lists the other designators by name only. They are marked as taking an identifier by the
 *   same pattern. The document does not show that.
 *
 * @see {@link https://lastation.laposte.fr/sites/p8_u1/files/2026-07/SP8855-Volume%202_V1.14%20-%20Adressage%20des%20plis.pdf La Poste, SP 8855 Volume 2, Adressage des plis (v1.14)}
 */

import type { PostalGuidelineCitation, PostalUnitGuidelineRule, PostalUnitKind } from "#postal/guideline"

const SP_8855 = {
	document: "Adressage des plis SP 8855 – Volume 2",
	publisher: "La Poste, Branche Services-Courrier-Colis, Direction technique",
	edition: "Version 1.14",
	section: "3.2. L’adresse d’un particulier",
	url: "https://lastation.laposte.fr/sites/p8_u1/files/2026-07/SP8855-Volume%202_V1.14%20-%20Adressage%20des%20plis.pdf",
	sha256: "65d3bff819e556ef68e55fb3f3567d0f0b9f610c2b09020154bc1b121be1683a",
	fetched: "2026-10-20",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription">

const LINE_TWO_QUOTE = "2- N° APP ou BAL-ETAGE-COULOIR-ESCALIER"
const LINE_THREE_QUOTE = "3- ENTREE-BATIMENT-IMMEUBLE-TOUR-RESIDENCE-LOTISSEMENT"

/**
 * Builds one designator's rule from the line that lists it.
 */
function lineRule(
	id: string,
	kind: PostalUnitKind,
	designator: string,
	abbreviation: string | null,
	line: 2 | 3
): PostalUnitGuidelineRule {
	return {
		id,
		kind,
		designator,
		abbreviation,
		requiresIdentifier: true,
		statement: `${designator} is written on line ${line}, ${line === 2 ? "inside the building" : "outside the building"}.`,
		citation: { ...SP_8855, quote: line === 2 ? LINE_TWO_QUOTE : LINE_THREE_QUOTE, transcription: null },
	}
}

/**
 * The La Poste line 2 and line 3 designators, each with the line that lists it.
 *
 * The flat is `APPARTEMENT`, which line 2 abbreviates `APP` and the example writes `Appartement`.
 */
export const FR_UNIT_LINE_RULES: readonly PostalUnitGuidelineRule[] = [
	lineRule("fr-line-2-appartement", "unit", "APPARTEMENT", "APP", 2),
	lineRule("fr-line-2-bal", "interior", "BAL", null, 2),
	lineRule("fr-line-2-etage", "level", "ETAGE", null, 2),
	lineRule("fr-line-2-couloir", "interior", "COULOIR", null, 2),
	lineRule("fr-line-2-escalier", "staircase", "ESCALIER", null, 2),
	lineRule("fr-line-3-entree", "entrance", "ENTREE", null, 3),
	lineRule("fr-line-3-batiment", "building", "BATIMENT", null, 3),
	lineRule("fr-line-3-immeuble", "building", "IMMEUBLE", null, 3),
	lineRule("fr-line-3-tour", "building", "TOUR", null, 3),
	lineRule("fr-line-3-residence", "building", "RESIDENCE", null, 3),
	lineRule("fr-line-3-lotissement", "building", "LOTISSEMENT", null, 3),
]

/**
 * Where lines 2 and 3 sit, and the document's worked example.
 */
export const FR_UNIT_PLACEMENT_RULES = [
	{
		id: "fr-line-2-inside-line-3-outside",
		statement: "Line 2 holds what is inside the building and line 3 what is outside it.",
		citation: {
			...SP_8855,
			quote:
				"La ligne 2 correspond à tout ce qui est situé à l’intérieur d’un bâtiment, la ligne 3 tout ce qui est " +
				"à l’extérieur.",
			transcription: null,
		},
	},
	{
		id: "fr-individual-example",
		statement:
			"The worked example writes the flat on line 2, the entrance and building on line 3, then the number and " +
			"street, the commune and the postcode with the locality.",
		citation: {
			...SP_8855,
			quote:
				"Exemple : Monsieur Jean DELORME Appartement 2 ENTREE A BATIMENT JONQUILLE 25 RUE DE L’EGLISE CAUDOS " +
				"33380 MIOS",
			transcription: "The example's six lines are joined by one space each.",
		},
	},
] as const
