/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Deutsche Post rule for a Postfach address: the Postfach number replaces the street and house
 *   number, and the PLZ and Ort line follows it.
 *
 * @see {@link https://www.deutschepost.de/de/b/briefumschlag-richtig-beschriften.html Deutsche Post, Briefumschlag richtig adressieren}
 */

import type { PoBoxGuidelineRule, PostalGuidelineCitation } from "#postal/guideline"

const BRIEFUMSCHLAG_PAGE = {
	document: "Briefumschlag beschriften & Brief richtig adressieren",
	publisher: "Deutsche Post",
	edition: "undated",
	section: "An eine Postfachadresse",
	url: "https://www.deutschepost.de/de/b/briefumschlag-richtig-beschriften.html",
	sha256: "9de9f916817e415dd3829e72f9212934ff348ff80612432422c3aa29dd0ceaa5",
	fetched: "2026-10-20",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription">

/**
 * The Deutsche Post Postfach rules.
 */
export const DE_POSTFACH_RULES = [
	{
		id: "de-postfach-replaces-street",
		designator: "Postfach",
		requiresNumber: true,
		requiresOffice: false,
		statement:
			"A Postfach address gives the Postfach number in place of the street and house number, and needs no Ortsteil.",
		citation: {
			...BRIEFUMSCHLAG_PAGE,
			quote:
				"Beim Versand an eine Postfachadresse entfällt die Angabe von Straße und Hausnummer. Statt Straße und " +
				"Hausnummer geben Sie die Postfachnummer an. Eine Ortsteilbezeichnung ist nicht notwendig.",
			transcription: "HTML entities in the fetched page (&szlig;, &auml;) decoded to their characters.",
		},
	},
	{
		id: "de-postfach-example",
		designator: "Postfach",
		requiresNumber: true,
		requiresOffice: false,
		statement:
			"The page's example writes a six-digit Postfach number in pairs, followed by the PLZ and Ort on the next line.",
		citation: {
			...BRIEFUMSCHLAG_PAGE,
			quote: "Beispiel: Franz Fröhlich AG Postfach 10 64 38 53225 Bonn",
			transcription:
				"The example's address lines are joined by single spaces, as the page's text extraction joins them; " +
				"HTML entities decoded.",
		},
	},
] as const satisfies readonly PoBoxGuidelineRule[]

/**
 * Writes a six-digit Postfach number in pairs, as the Deutsche Post example writes `10 64 38`.
 *
 * Throws on any other length, because the cited page shows only the six-digit form.
 */
export function formatPostfachNumber(digits: string): string {
	if (!/^\d{6}$/u.test(digits)) {
		throw new Error(`formatPostfachNumber: the cited example writes six digits; received "${digits}".`)
	}

	return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4)}`
}
