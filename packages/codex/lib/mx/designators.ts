/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mexican designators: apartado, premise and sub-premise words, floors, number marks and Spanish relation
 *   words. Correos de México publishes its address layout through the UPU sheet. The sheet shows `Piso` and
 *   `Super Manzana`. The remaining words take a dictionary entry as their source.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/mexEn.pdf UPU Mexico postal address sheet (Correos de México)}
 * @see {@link https://en.wiktionary.org/wiki/apartado Wiktionary, apartado}
 * @see {@link https://en.wiktionary.org/wiki/edificio Wiktionary, edificio}
 * @see {@link https://en.wiktionary.org/wiki/torre Wiktionary, torre}
 * @see {@link https://en.wiktionary.org/wiki/sala Wiktionary, sala}
 * @see {@link https://en.wiktionary.org/wiki/casa Wiktionary, casa}
 * @see {@link https://en.wiktionary.org/wiki/lote Wiktionary, lote}
 * @see {@link https://en.wiktionary.org/wiki/manzana Wiktionary, manzana}
 * @see {@link https://en.wiktionary.org/wiki/s%2Fn Wiktionary, s/n}
 * @see {@link https://en.wiktionary.org/wiki/cerca_de Wiktionary, cerca de}
 * @see {@link https://en.wiktionary.org/wiki/junto_a Wiktionary, junto a}
 * @see {@link https://en.wiktionary.org/wiki/frente_a Wiktionary, frente a}
 * @see {@link https://en.wiktionary.org/wiki/en Wiktionary, en}
 * @see {@link https://en.wiktionary.org/wiki/post_office_box Wiktionary, post office box (translations)}
 * @see {@link https://es.wikipedia.org/wiki/Apartado_de_correos es.wikipedia, Apartado de correos}
 * @see {@link https://parcelpath.com/international-shipping/destinations/north-america/mexico/mexico-address-format/ ParcelPath, Mexico address format}
 * @see {@link https://en.wiktionary.org/wiki/int. Wiktionary, int.}
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
} from "#postal/designator"

const UPU = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/mexEn.pdf"

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
 * The Mexican designator table, read from the UPU sheet for Correos de México and dictionary entries.
 */
export const MX_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "MX",
	rows: [
		row(
			"Apartado",
			"post_office_box",
			`${wiktionary("apartado")} and ${wiktionary("post_office_box")} and https://es.wikipedia.org/wiki/Apartado_de_correos`,
			{ abbreviations: ["Apartado postal", "Apartado de correos"] }
		),
		row("Edificio", "building", wiktionary("edificio")),
		row("Torre", "tower", wiktionary("torre")),
		row("Super Manzana", "block", UPU),
		row("Sala", "room", wiktionary("sala")),
		row("Casa", "unit", wiktionary("casa")),
		row("Lote", "unit", wiktionary("lote")),
		row("Manzana", "block", wiktionary("manzana")),
		...FLOOR_ROWS,
		row("S/N", "number_sign", wiktionary("s%2Fn"), { position: "standalone" }),
		row("cerca de", "near", wiktionary("cerca_de")),
		row("cerca de mí", "near_asker", NEAR_ASKER_SOURCE, { position: "standalone" }),
		row(
			"Int.",
			"unit",
			`https://parcelpath.com/international-shipping/destinations/north-america/mexico/mexico-address-format/ and ${wiktionary("int.")}`
		),
		row("junto a", "beside", wiktionary("junto_a")),
		row("frente a", "opposite", wiktionary("frente_a")),
		row("en", "in", wiktionary("en")),
	],
}
