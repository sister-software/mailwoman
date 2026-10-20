/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australia Post's rules for a delivery-service address, each with the sentence or table row that
 *   states it. The Correct Addressing brochure places a PO Box or Locked Bag on the second line and
 *   writes the third line in capitals. The barcode booklet's Postal Delivery Type table supplies the
 *   abbreviations CARE PO, MS and RMS. Whether a type takes a number is read from
 *   {@linkcode AU_DELIVERY_SERVICE_DESIGNATORS}, which neither document states directly.
 *
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/correct-addressing.pdf Australia Post Correct Addressing brochure (Nov 2022)}
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf Australia Post barcode addressing booklet (Postal Delivery Type table)}
 */

import { AU_DELIVERY_SERVICE_DESIGNATORS, type AuDeliveryServiceAbbreviation } from "#au/delivery-service"
import type { PoBoxGuidelineRule, PostalGuidelineCitation } from "#postal-guideline"

const CORRECT_ADDRESSING = {
	document: "Correct addressing",
	publisher: "Australia Post",
	edition: "SAP 8833878 Nov 2022",
	section: "Mail Addressing Guidelines",
	url: "https://auspost.com.au/content/dam/auspost_corp/media/documents/correct-addressing.pdf",
	sha256: "d0925a8acb31ab7e5bb2503f61626831d51cf3f606f9971266e7b5af1506e21d",
	fetched: "2026-10-20",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription">

const HINTS_AND_TIPS = {
	document: "Hints and tips to get a higher address match rate",
	publisher: "Australia Post",
	edition: "176067_Hints & Tips 20pp, print stamp 9/7/03",
	section: "Common address component abbreviations, Postal Delivery Type",
	url: "https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf",
	sha256: "380bd7f458568e6ad5e500f62f2166c89816d5aab4daaa01abf2cf32b7e525a1",
	fetched: "2026-10-20",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription">

const LINE_TWO_QUOTE = "Line 2 should contain the street number and name, or PO Box or Locked Bag number if applicable."

const LINE_BREAK_TRANSCRIPTION = "The brochure's line breaks within the sentence read as single spaces."

const TABLE_TRANSCRIPTION = "One row of the table, its two cells joined by one space in place of the column padding."

const requiresNumber = (abbreviation: AuDeliveryServiceAbbreviation): boolean =>
	AU_DELIVERY_SERVICE_DESIGNATORS.some((entry) => entry.abbreviation === abbreviation && entry.requiresNumber)

/**
 * The cited Australia Post delivery-service rules.
 */
export const AU_DELIVERY_GUIDELINE_RULES = [
	{
		id: "au-po-box-line-2",
		designator: "PO BOX",
		requiresNumber: requiresNumber("PO BOX"),
		requiresOffice: false,
		statement: "A PO Box number takes the second line, in place of the street number and name.",
		citation: { ...CORRECT_ADDRESSING, quote: LINE_TWO_QUOTE, transcription: LINE_BREAK_TRANSCRIPTION },
	},
	{
		id: "au-locked-bag-line-2",
		designator: "LOCKED BAG",
		requiresNumber: requiresNumber("LOCKED BAG"),
		requiresOffice: false,
		statement: "A Locked Bag number takes the second line, in place of the street number and name.",
		citation: { ...CORRECT_ADDRESSING, quote: LINE_TWO_QUOTE, transcription: LINE_BREAK_TRANSCRIPTION },
	},
	{
		id: "au-care-po",
		designator: "CARE PO",
		requiresNumber: requiresNumber("CARE PO"),
		requiresOffice: false,
		statement: "Care of Post Office is abbreviated CARE PO.",
		citation: { ...HINTS_AND_TIPS, quote: "CARE OF POST OFFICE CARE PO", transcription: TABLE_TRANSCRIPTION },
	},
	{
		id: "au-mail-service",
		designator: "MS",
		requiresNumber: requiresNumber("MS"),
		requiresOffice: false,
		statement: "Mail Service is abbreviated MS.",
		citation: { ...HINTS_AND_TIPS, quote: "MAIL SERVICE MS", transcription: TABLE_TRANSCRIPTION },
	},
	{
		id: "au-roadside-mail-service",
		designator: "RMS",
		requiresNumber: requiresNumber("RMS"),
		requiresOffice: false,
		statement: "Roadside Mail Service is abbreviated RMS.",
		citation: { ...HINTS_AND_TIPS, quote: "ROADSIDE MAIL SERVICE RMS", transcription: TABLE_TRANSCRIPTION },
	},
] as const satisfies readonly PoBoxGuidelineRule[]

/**
 * The brochure's rule for the line after a delivery-service line.
 */
export const AU_LOCALITY_LINE_RULE = {
	statement: "The locality line is written in capitals and holds the locality or suburb, the state and the postcode.",
	citation: {
		...CORRECT_ADDRESSING,
		quote: "Line 3 should be written in capital letters and contain the locality or suburb, state and postcode.",
		transcription: LINE_BREAK_TRANSCRIPTION,
	},
} as const satisfies { statement: string; citation: PostalGuidelineCitation }
