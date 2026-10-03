/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Readers for the three French postal-line shapes that the FINESS and Annuaire de l'éducation
 * publications share: the La Poste routing line (`97100 BASSE TERRE`, `97331 CAYENNE CEDEX`), a
 * line holding a post-office box among other text (`ZA ESPERANCE - BP 26`), and the comparison of
 * two place names written in different forms (`ST PIERRE` against `Saint-Pierre`).
 *
 * Both adapters read French overseas registers, and both publishers write these lines the same
 * way, so the readers live in one module rather than in each adapter.
 */

import { matchCedex } from "@mailwoman/codex/fr/cedex"
import { foldToken } from "@mailwoman/codex/normalize"

/**
 * A routing line split into the components the French address layout prints on its last line.
 */
export interface AcheminementLine {
	postcode: string
	locality: string
	/**
	 * The `CEDEX` phrase with its office number, as written, when the line ends with one.
	 */
	cedex?: string
}

/**
 * Five digits, a space, and the routing locality.
 */
const ACHEMINEMENT = /^(\d{5}) (.+)$/u

/**
 * Split a La Poste routing line into postcode, locality and an optional trailing `CEDEX`.
 *
 * Returns `null` when the line does not open with a five-digit postcode,
 * holds no locality after it, or holds `CEDEX` anywhere but at its end, because none
 * of those is a routing line the French layout can print.
 */
export function parseAcheminementLine(line: string): AcheminementLine | null {
	const collapsed = line.replaceAll(/\s+/gu, " ").trim()
	const match = ACHEMINEMENT.exec(collapsed)

	if (!match) return null

	const postcode = match[1]!
	const rest = match[2]!.trim()
	const cedex = matchCedex(rest)

	if (!cedex) return { postcode, locality: rest }

	if (cedex.end !== rest.length) return null

	const locality = rest.slice(0, cedex.start).trim()

	if (!locality) return null

	return { postcode, locality, cedex: cedex.matched }
}

/**
 * A post-office box designator and its number.
 *
 * `BP` is boîte postale, `CS` is La Poste's course spéciale and `TSA` its tri service
 * arrivée, all three delivered to a box rather than to the premise.
 * New Caledonia numbers its boxes with a letter prefix (`BP M2`, `BP MGA 19`, `BP KO243`),
 * which is why up to three letters may precede the digits.
 */
const POST_BOX = /(?<![\p{L}\d])(?:B\.?\s?P\.?|CS|TSA)\s*(?:N°\s*)?(?:[A-Z]{1,3}\s?)?\d+(?![\p{L}\d])/iu

/**
 * Separators a publisher leaves around a box once it is removed: `ZA ESPERANCE - BP 26`.
 */
const EDGE_SEPARATORS = /^[\s\-–—/,;:.]+|[\s\-–—/,;:.]+$/gu

/**
 * A line with its post-office box taken out.
 */
export interface PostBoxSplit {
	/**
	 * The box as written, with its whitespace collapsed, or `null` where the line holds none.
	 */
	poBox: string | null
	/**
	 * What the line holds besides the box, with the separators around it removed.
	 */
	remainder: string
}

/**
 * Take the first post-office box out of a line.
 *
 * `SAVANNAH BP 90149` yields `BP 90149` and `SAVANNAH`, and `BP 381-SPRING CONCORDIA -`
 * yields `BP 381` and `SPRING CONCORDIA`.
 */
export function splitPostBox(line: string): PostBoxSplit {
	const collapsed = line.replaceAll(/\s+/gu, " ").trim()
	const match = POST_BOX.exec(collapsed)

	if (!match) return { poBox: null, remainder: collapsed.replaceAll(EDGE_SEPARATORS, "") }

	const before = collapsed.slice(0, match.index).replaceAll(EDGE_SEPARATORS, "")
	const after = collapsed.slice(match.index + match[0].length).replaceAll(EDGE_SEPARATORS, "")

	return {
		poBox: match[0].replaceAll(/\s+/gu, " "),
		remainder: [before, after].filter((part) => part !== "").join(" "),
	}
}

/**
 * The opening word of a line that locates a part of a building or a landmark rather than a place:
 * a building, a floor, a staircase, a door, a corner, a car park, a school's grounds.
 *
 * Both publishers put such text on the line a lieu-dit takes (`IMMEUBLE SEMAFA`, `BAT SOUS MARQUE B
 * - RDC`, `ANGLE DES RUES JEAN JAURES`, `ENCEINTE ECOLE DE TIAPA`), and labeling it a dependent
 * locality would teach a building name as a place name.
 * `Lotissement` and `Résidence` are not in the list: in the overseas departments both
 * name the housing estate an address is in, and TRE-R35 codes both as street types.
 */
const PREMISE_DESCRIPTOR =
	/^(?:imm(?:euble)?|b[aâ]t(?:iment)?|appt?|appartement|étage|etage|rdc|rez[- ]de[- ]chauss[ée]e|esc(?:alier)?|porte|local|angle|centre commercial|ccial|ccal|enceinte|parking|entr[ée]e|lyc[ée]e|coll[èe]ge|[ée]cole|maison|rectorat|vice[- ]rectorat|mairie|face|derri[èe]re|pr[èe]s|[àa] c[ôo]t[ée])(?![\p{L}\d])/iu

/**
 * Whether a line locates part of a building or a landmark rather than a place.
 */
export function isPremiseDescriptor(line: string): boolean {
	return PREMISE_DESCRIPTOR.test(line.trim())
}

/**
 * The abbreviations La Poste's routing lines use for the hagionymic prefixes.
 */
const SAINT_FORMS: Readonly<Record<string, string>> = { st: "saint", ste: "sainte", sts: "saints", stes: "saintes" }

/**
 * A place name folded for comparison: case, diacritics, punctuation and the `ST` abbreviation.
 */
function placeKey(value: string): string {
	return foldToken(value)
		.replaceAll(/[^\p{L}\d]+/gu, " ")
		.trim()
		.split(" ")
		.map((word) => SAINT_FORMS[word] ?? word)
		.join(" ")
}

/**
 * Whether two place names write the same place: `ST PIERRE` and `Saint-Pierre`, `MATA'UTU` and `Mata Utu`.
 */
export function isSamePlace(left: string, right: string): boolean {
	const leftKey = placeKey(left)

	return leftKey.length > 0 && leftKey === placeKey(right)
}
