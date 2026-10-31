/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Poste Italiane rule for the building line: the optional third line of an address gives the
 *   staircase (`scala`), the floor (`piano`) and the door (`interno`). The fourth line is the street
 *   and civic number, and the fifth the CAP, the locality and the province abbreviation, as
 *   `IT_CASELLA_POSTALE_RULES` cites.
 *
 *   The document writes the three words in lower case and in that order, and gives no abbreviation.
 *
 * @see {@link https://business.poste.it/business/files/1476488640071/posta-registrata-caratteristiche-standard-invii.pdf Poste Italiane, Caratteristiche standard degli invii – Posta Registrata (PRS.INDES.STA.1)}
 */

import { IT_POSTA_REGISTRATA_CITATION, IT_POSTA_REGISTRATA_COLUMN_TRANSCRIPTION } from "#it/casella-postale"
import type { PostalUnitGuidelineRule, PostalUnitKind } from "#postal/guideline"

const LINE_THREE_QUOTE = "3° riga: facoltativa per informazioni aggiuntive sull’edificio (scala, piano, interno)"

/**
 * Builds one designator's rule from the third-line requirement.
 */
function lineThreeRule(designator: string, kind: PostalUnitKind, meaning: string): PostalUnitGuidelineRule {
	return {
		id: `it-line-3-${designator}`,
		kind,
		designator,
		abbreviation: null,
		requiresIdentifier: true,
		statement: `The optional third line gives the ${meaning} as ${designator} and its identifier.`,
		citation: {
			...IT_POSTA_REGISTRATA_CITATION,
			quote: LINE_THREE_QUOTE,
			transcription: IT_POSTA_REGISTRATA_COLUMN_TRANSCRIPTION,
		},
	}
}

/**
 * The Poste Italiane third-line designators, in the order the document lists them.
 */
export const IT_UNIT_LINE_RULES: readonly PostalUnitGuidelineRule[] = [
	lineThreeRule("scala", "staircase", "staircase"),
	lineThreeRule("piano", "level", "floor"),
	lineThreeRule("interno", "unit", "door"),
]
