/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Canadian designators in English and French: postal box, rural route, general delivery, station and unit
 *   designators, and the relation words. Canada Post writes the same delivery types with different
 *   abbreviations in each language (`PO BOX` and `CP`, `GD` and `PR`, `STN` and `SUCC`), so every row carries
 *   its language.
 *
 * @see {@link https://www.canadapost-postescanada.ca/cpc/doc/en/support/addressing-guidelines.pdf Canada Post addressing guidelines (June 14, 2021)}
 * @see {@link https://www.canadapost-postescanada.ca/scp/doc/fr/soutien/directives-dadressage.pdf Canada Post directives d'adressage (14 juin 2021)}
 * @see {@link https://www.canadapost-postescanada.ca/scp/fr/soutien/sujet/directives-adressage/adresses-canada.page Canada Post directives d'adressage, adresses au Canada}
 * @see {@link https://bac-lac.wayback.archive-it.org/web/20061207020932/https:/canadapost.ca/tools/pg/manual/b03-e.asp Canada Post Postal Guide manual, section B03 (archived 2006)}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary, near}
 * @see {@link https://en.wiktionary.org/wiki/next_to Wiktionary, next to}
 * @see {@link https://en.wiktionary.org/wiki/pr%C3%A8s_de Wiktionary, près de}
 * @see {@link https://en.wiktionary.org/wiki/in Wiktionary, in}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary, me}
 * @see {@link https://en.wiktionary.org/wiki/moi Wiktionary, moi}
 * @see {@link https://en.wiktionary.org/wiki/floor Wiktionary, floor (translations)}
 * @see {@link https://en.wiktionary.org/wiki/ground_floor Wiktionary, ground floor (translations)}
 * @see {@link https://en.wiktionary.org/wiki/basement Wiktionary, basement (translations)}
 * @see {@link https://en.wiktionary.org/wiki/penthouse Wiktionary, penthouse (translations)}
 */

import { EN_LEVEL_DESIGNATORS, FR_LEVEL_DESIGNATORS, type LevelDesignatorRow } from "#level-semantics"
import {
	designatorRowsFromLevels,
	type DesignatorConcept,
	type PostalDesignatorRow,
	type PostalDesignatorTable,
} from "#postal-designator"

const EN_GUIDELINES = "https://www.canadapost-postescanada.ca/cpc/doc/en/support/addressing-guidelines.pdf"
const FR_GUIDELINES = "https://www.canadapost-postescanada.ca/scp/doc/fr/soutien/directives-dadressage.pdf"
const FR_PAGE = "https://www.canadapost-postescanada.ca/scp/fr/soutien/sujet/directives-adressage/adresses-canada.page"

const ARCHIVED_MANUAL =
	"https://bac-lac.wayback.archive-it.org/web/20061207020932/https:/canadapost.ca/tools/pg/manual/b03-e.asp"

function row(
	language: "en" | "fr",
	spelling: string,
	concept: DesignatorConcept,
	source: string,
	options: Partial<Pick<PostalDesignatorRow, "abbreviations" | "position">> = {}
): PostalDesignatorRow {
	return {
		spelling,
		abbreviations: options.abbreviations ?? [],
		script: "Latn",
		position: options.position ?? "prefix",
		concept,
		language,
		source,
	}
}

const FLOOR = "https://en.wiktionary.org/wiki/floor"
const GROUND_FLOOR = "https://en.wiktionary.org/wiki/ground_floor"
const BASEMENT = "https://en.wiktionary.org/wiki/basement"
const PENTHOUSE = "https://en.wiktionary.org/wiki/penthouse"

function levelRows(
	language: "en" | "fr",
	levels: readonly LevelDesignatorRow[],
	picks: ReadonlyArray<{ code: string; spelling: string; source: string }>
): PostalDesignatorRow[] {
	return picks.flatMap(({ code, spelling, source }) =>
		designatorRowsFromLevels(
			levels.filter((level) => level.code === code),
			{ script: "Latn", language, source }
		).map((floor) => ({ ...floor, spelling, abbreviations: [] }))
	)
}

const EN_FLOOR_ROWS = levelRows("en", EN_LEVEL_DESIGNATORS, [
	{ code: "FLOOR", spelling: "Floor", source: FLOOR },
	{ code: "GROUND", spelling: "Ground floor", source: GROUND_FLOOR },
	{ code: "BASEMENT", spelling: "Basement", source: BASEMENT },
	{ code: "PENTHOUSE", spelling: "Penthouse", source: PENTHOUSE },
])

const FR_FLOOR_ROWS = levelRows("fr", FR_LEVEL_DESIGNATORS, [
	{ code: "ÉTAGE", spelling: "Étage", source: FLOOR },
	{ code: "RDC", spelling: "Rez-de-chaussée", source: GROUND_FLOOR },
	{ code: "SOUS-SOL", spelling: "Sous-sol", source: BASEMENT },
])

const NEAR_ME_SOURCE =
	"composed from the near row and the first-person pronoun (Wiktionary https://en.wiktionary.org/wiki/me)"

const NEAR_MOI_SOURCE =
	"composed from the près de row and the first-person pronoun (Wiktionary https://en.wiktionary.org/wiki/moi)"

/**
 * The Canadian designator table in English and French, read from Canada Post's addressing guidelines.
 */
export const CA_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "CA",
	rows: [
		// English
		row("en", "PO BOX", "post_office_box", EN_GUIDELINES),
		row("en", "RR", "rural_route", `${EN_GUIDELINES} and ${ARCHIVED_MANUAL}`, { abbreviations: ["RURAL ROUTE"] }),
		row("en", "SS", "rural_route", ARCHIVED_MANUAL),
		row("en", "MR", "rural_route", ARCHIVED_MANUAL),
		row("en", "GD", "poste_restante", `${EN_GUIDELINES} and ${ARCHIVED_MANUAL}`, {
			abbreviations: ["GENERAL DELIVERY"],
			position: "standalone",
		}),
		row("en", "STN", "special_routing", `${EN_GUIDELINES} and ${ARCHIVED_MANUAL}`, { abbreviations: ["STATION"] }),
		row("en", "RPO", "special_routing", `${EN_GUIDELINES} and ${ARCHIVED_MANUAL}`, {
			abbreviations: ["RETAIL POSTAL OUTLET"],
		}),
		row("en", "SUITE", "suite", ARCHIVED_MANUAL),
		row("en", "APT", "apartment", ARCHIVED_MANUAL, { abbreviations: ["APARTMENT"] }),
		row("en", "UNIT", "unit", ARCHIVED_MANUAL),
		row("en", "near", "near", "https://en.wiktionary.org/wiki/near"),
		row("en", "next to", "beside", "https://en.wiktionary.org/wiki/next_to"),
		row("en", "near me", "near_asker", NEAR_ME_SOURCE, { position: "standalone" }),
		row("en", "in", "in", "https://en.wiktionary.org/wiki/in"),
		...EN_FLOOR_ROWS,
		// French
		row("fr", "CP", "post_office_box", `${FR_GUIDELINES} and ${FR_PAGE}`, { abbreviations: ["CASE POSTALE"] }),
		row("fr", "RR", "rural_route", `${FR_GUIDELINES} and ${FR_PAGE}`, { abbreviations: ["ROUTE RURALE"] }),
		row("fr", "PR", "poste_restante", `${FR_GUIDELINES} and ${FR_PAGE}`, {
			abbreviations: ["POSTE RESTANTE"],
			position: "standalone",
		}),
		row("fr", "SUCC", "special_routing", `${FR_GUIDELINES} and ${FR_PAGE}`, { abbreviations: ["SUCCURSALE"] }),
		row("fr", "BUREAU", "office", ARCHIVED_MANUAL),
		row("fr", "APP", "apartment", ARCHIVED_MANUAL, { abbreviations: ["APPARTEMENT"] }),
		row("fr", "près de", "near", "https://en.wiktionary.org/wiki/pr%C3%A8s_de"),
		row("fr", "près de moi", "near_asker", NEAR_MOI_SOURCE, { position: "standalone" }),
		...FR_FLOOR_ROWS,
	],
}
