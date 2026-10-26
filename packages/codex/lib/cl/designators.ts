/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Chilean designators: casilla, premise and sub-premise words, floors, number marks and Spanish relation
 *   words. The Correos Chile sheet on the UPU site shows `Casilla`, `Depto.`, `Piso`, `Edificio`, `S/N` and
 *   `Km.`. The remaining words take a dictionary entry as their source.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/chlEn.pdf UPU Chile postal address sheet (Correos Chile)}
 * @see {@link https://en.wiktionary.org/wiki/torre Wiktionary, torre}
 * @see {@link https://en.wiktionary.org/wiki/sala Wiktionary, sala}
 * @see {@link https://en.wiktionary.org/wiki/casa Wiktionary, casa}
 * @see {@link https://en.wiktionary.org/wiki/lote Wiktionary, lote}
 * @see {@link https://en.wiktionary.org/wiki/manzana Wiktionary, manzana}
 * @see {@link https://en.wiktionary.org/wiki/cerca_de Wiktionary, cerca de}
 * @see {@link https://en.wiktionary.org/wiki/junto_a Wiktionary, junto a}
 * @see {@link https://en.wiktionary.org/wiki/frente_a Wiktionary, frente a}
 * @see {@link https://en.wiktionary.org/wiki/en Wiktionary, en}
 * @see {@link https://en.wiktionary.org/wiki/ground_floor Wiktionary, ground floor (translations)}
 * @see {@link https://en.wiktionary.org/wiki/basement Wiktionary, basement (translations)}
 * @see {@link https://en.wiktionary.org/wiki/penthouse Wiktionary, penthouse (translations)}
 * @see {@link https://en.wiktionary.org/wiki/m%C3%AD Wiktionary, mí}
 */

import { ES_LEVEL_DESIGNATORS } from "#level-semantics"
import {
	designatorRowsFromLevels,
	type DesignatorConcept,
	type PostalDesignatorRow,
	type PostalDesignatorTable,
} from "#postal-designator"

const UPU = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/chlEn.pdf"

function wiktionary(entry: string): string {
	return `https://en.wiktionary.org/wiki/${entry}`
}

function row(
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
		language: "es",
		source,
	}
}

const LEVELS = [
	{ code: "PLANTA", spelling: "Piso", source: UPU },
	{ code: "PLANTA BAJA", spelling: "Planta baja", source: wiktionary("ground_floor") },
	{ code: "SÓTANO", spelling: "Sótano", source: wiktionary("basement") },
	{ code: "ÁTICO", spelling: "Ático", source: wiktionary("penthouse") },
]

const FLOOR_ROWS = LEVELS.flatMap(({ code, spelling, source }) =>
	designatorRowsFromLevels(
		ES_LEVEL_DESIGNATORS.filter((level) => level.code === code),
		{ script: "Latn", language: "es", source }
	).map((floor) => ({ ...floor, spelling, abbreviations: [] }))
)

const NEAR_ASKER_SOURCE =
	"composed from the cerca de row and the first-person pronoun (Wiktionary https://en.wiktionary.org/wiki/m%C3%AD)"

/**
 * The Chilean designator table, read from the UPU sheet for Correos Chile and dictionary entries.
 */
export const CL_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "CL",
	rows: [
		row("Casilla", "post_office_box", UPU),
		row("Edificio", "building", UPU),
		row("Torre", "tower", wiktionary("torre")),
		row("Depto.", "apartment", UPU),
		row("Sala", "room", wiktionary("sala")),
		row("Casa", "unit", wiktionary("casa")),
		row("Lote", "unit", wiktionary("lote")),
		row("Manzana", "block", wiktionary("manzana")),
		...FLOOR_ROWS,
		row("S/N", "number_sign", `${UPU} and ${wiktionary("s%2Fn")}`, { position: "standalone" }),
		row("Km.", "number_sign", UPU),
		row("cerca de", "near", wiktionary("cerca_de")),
		row("cerca de mí", "near_asker", NEAR_ASKER_SOURCE, { position: "standalone" }),
		row("junto a", "beside", wiktionary("junto_a")),
		row("frente a", "opposite", wiktionary("frente_a")),
		row("en", "in", wiktionary("en")),
	],
}
