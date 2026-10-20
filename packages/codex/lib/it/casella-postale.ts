/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Poste Italiane rule for a casella postale address: the fourth line writes the words
 *   `CASELLA POSTALE`, the box number and the office that holds the box, in place of the street and
 *   civic number. The fifth line writes the CAP, the locality and the province abbreviation.
 *
 * @see {@link https://business.poste.it/business/files/1476488640071/posta-registrata-caratteristiche-standard-invii.pdf Poste Italiane, Caratteristiche standard degli invii – Posta Registrata (PRS.INDES.STA.1)}
 */

import type { PoBoxGuidelineRule, PostalGuidelineCitation } from "#postal-guideline"

const POSTA_REGISTRATA = {
	document: "Caratteristiche standard degli invii – Posta Registrata",
	publisher: "Poste Italiane",
	edition: "PRS.INDES.STA.1 - Versione 3 - Ed. 14/10/2025",
	section: "1.1 Layout dell’invio di Posta Registrata nazionale, Requisiti indirizzo, Struttura",
	url: "https://business.poste.it/business/files/1476488640071/posta-registrata-caratteristiche-standard-invii.pdf",
	sha256: "3d77a1f795ccf658f66c9e98544b450a2f34cee931d5b0f5f9855020172543eb",
	fetched: "2026-10-20",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription">

const COLUMN_TRANSCRIPTION =
	"The PDF sets this table in two columns, so its extracted text interleaves the cells; the line was " +
	"rejoined from its fragments, without the stray page-column digit between them."

/**
 * The Poste Italiane casella postale rules.
 */
export const IT_CASELLA_POSTALE_RULES = [
	{
		id: "it-casella-postale-line-4",
		designator: "CASELLA POSTALE",
		requiresNumber: true,
		requiresOffice: true,
		statement:
			"The fourth address line gives the words CASELLA POSTALE, the box number and the office where the box is, " +
			"in place of the street and civic number.",
		citation: {
			...POSTA_REGISTRATA,
			quote:
				"4° riga: via nome della via numero civico (in alternativa la dicitura “CASELLA POSTALE”, il numero " +
				"della stessa e l’ufficio dove è ubicata)",
			transcription: COLUMN_TRANSCRIPTION,
		},
	},
	{
		id: "it-casella-postale-line-5",
		designator: "CASELLA POSTALE",
		requiresNumber: true,
		requiresOffice: true,
		statement: "The fifth line gives the CAP, the locality and the province abbreviation, in that order.",
		citation: {
			...POSTA_REGISTRATA,
			quote: "5° riga: CAP località sigla provincia",
			transcription: COLUMN_TRANSCRIPTION,
		},
	},
	{
		id: "it-casella-postale-contact-example",
		designator: "Casella Postale",
		requiresNumber: true,
		requiresOffice: false,
		statement:
			"Poste Italiane's own contact address writes Casella Postale and the number, a dash, then the CAP and the " +
			"locality, with no office named.",
		citation: {
			...POSTA_REGISTRATA,
			section: "Contatti, Scrivici (page 44)",
			quote: "Casella Postale 160 – 00144 Roma",
			transcription: null,
		},
	},
] as const satisfies readonly PoBoxGuidelineRule[]
