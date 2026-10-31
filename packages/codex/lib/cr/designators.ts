/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Costa Rican designators: apartado, the `#` number mark, premise words, floors and the landmark-relative
 *   locator (`300 metros norte del rótulo de AyA`). The Correos de Costa Rica sheet on the UPU site shows `Apdo`
 *   and `#`. Distance units, directions and sides take dictionary entries and published descriptions of the
 *   address system as their sources, because no operator publishes a list of them.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/criEn.pdf UPU Costa Rica postal address sheet (Correos de Costa Rica)}
 * @see {@link https://es.wikipedia.org/wiki/Apartado_de_correos es.wikipedia, Apartado de correos}
 * @see {@link https://en.wiktionary.org/wiki/apartado Wiktionary, apartado}
 * @see {@link https://en.wiktionary.org/wiki/edificio Wiktionary, edificio}
 * @see {@link https://en.wiktionary.org/wiki/torre Wiktionary, torre}
 * @see {@link https://en.wiktionary.org/wiki/sala Wiktionary, sala}
 * @see {@link https://en.wiktionary.org/wiki/casa Wiktionary, casa}
 * @see {@link https://en.wiktionary.org/wiki/lote Wiktionary, lote}
 * @see {@link https://en.wiktionary.org/wiki/manzana Wiktionary, manzana}
 * @see {@link https://en.wiktionary.org/wiki/floor Wiktionary, floor (translations)}
 * @see {@link https://en.wiktionary.org/wiki/ground_floor Wiktionary, ground floor (translations)}
 * @see {@link https://en.wiktionary.org/wiki/basement Wiktionary, basement (translations)}
 * @see {@link https://en.wiktionary.org/wiki/penthouse Wiktionary, penthouse (translations)}
 * @see {@link https://en.wiktionary.org/wiki/s%2Fn Wiktionary, s/n}
 * @see {@link https://en.wiktionary.org/wiki/metro Wiktionary, metro}
 * @see {@link https://en.wiktionary.org/wiki/vara Wiktionary, vara}
 * @see {@link https://en.wiktionary.org/wiki/cuadra Wiktionary, cuadra}
 * @see {@link https://en.wiktionary.org/wiki/norte Wiktionary, norte}
 * @see {@link https://en.wiktionary.org/wiki/sur Wiktionary, sur}
 * @see {@link https://en.wiktionary.org/wiki/este Wiktionary, este}
 * @see {@link https://en.wiktionary.org/wiki/oeste Wiktionary, oeste}
 * @see {@link https://en.wiktionary.org/wiki/costado Wiktionary, costado}
 * @see {@link https://en.wiktionary.org/wiki/mano_derecha Wiktionary, mano derecha}
 * @see {@link https://en.wiktionary.org/wiki/mano_izquierda Wiktionary, mano izquierda}
 * @see {@link https://en.wiktionary.org/wiki/left Wiktionary, left (translations)}
 * @see {@link https://en.wiktionary.org/wiki/adjacent Wiktionary, adjacent (translations)}
 * @see {@link https://en.wiktionary.org/wiki/del Wiktionary, del}
 * @see {@link https://en.wiktionary.org/wiki/cerca_de Wiktionary, cerca de}
 * @see {@link https://en.wiktionary.org/wiki/frente_a Wiktionary, frente a}
 * @see {@link https://en.wiktionary.org/wiki/en Wiktionary, en}
 * @see {@link https://en.wiktionary.org/wiki/m%C3%AD Wiktionary, mí}
 * @see {@link https://www.nacion.com/viva/periodista-de-argentina-expone-el-enigma-de-las/7UZ7CNFW3JCOHANZJAIF7MFKRY/story/ La Nación, direcciones en Costa Rica}
 * @see {@link https://www.postcrossing.com/blog/2025/09/15/navigating-a-country-without-addresses Postcrossing, navigating a country without addresses}
 * @see {@link https://www.costaricaspanish.net/2008/06/finding-your-way-2/ Costa Rica Spanish, finding your way}
 */

import { ES_LEVEL_DESIGNATORS } from "#level-semantics"
import {
	designatorRowsFromLevels,
	type DesignatorConcept,
	type PostalDesignatorRow,
	type PostalDesignatorTable,
} from "#postal/designator"

const UPU = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/criEn.pdf"

const NACION =
	"https://www.nacion.com/viva/periodista-de-argentina-expone-el-enigma-de-las/7UZ7CNFW3JCOHANZJAIF7MFKRY/story/"

const POSTCROSSING = "https://www.postcrossing.com/blog/2025/09/15/navigating-a-country-without-addresses"

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
	{ code: "PLANTA", spelling: "Piso", source: wiktionary("floor") },
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

/**
 * The Costa Rican designator table, read from the UPU sheet and dictionary entries.
 *
 * The UPU sheet is the one Correos de Costa Rica supplies.
 */
export const CR_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "CR",
	rows: [
		row("Apdo", "post_office_box", `${UPU} and ${wiktionary("apartado")}`, {
			abbreviations: ["Apartado", "Apartado postal"],
		}),
		row("Edificio", "building", wiktionary("edificio")),
		row("Torre", "tower", wiktionary("torre")),
		row("Sala", "room", wiktionary("sala")),
		row("Casa", "unit", wiktionary("casa")),
		row("Lote", "unit", wiktionary("lote")),
		row("Manzana", "block", wiktionary("manzana")),
		...FLOOR_ROWS,
		row("#", "number_sign", UPU),
		row("S/N", "number_sign", wiktionary("s%2Fn"), { position: "standalone" }),
		row("metros", "distance_unit", wiktionary("metro"), { abbreviations: ["metro"], position: "suffix" }),
		row("varas", "distance_unit", wiktionary("vara"), { abbreviations: ["vara"], position: "suffix" }),
		row("cuadras", "distance_unit", wiktionary("cuadra"), { abbreviations: ["cuadra"], position: "suffix" }),
		row("norte", "direction", wiktionary("norte"), { position: "standalone" }),
		row("sur", "direction", wiktionary("sur"), { position: "standalone" }),
		row("este", "direction", wiktionary("este"), { position: "standalone" }),
		row("oeste", "direction", wiktionary("oeste"), { position: "standalone" }),
		row("mano derecha", "side", `${wiktionary("mano_derecha")} and ${POSTCROSSING}`, { position: "standalone" }),
		row("mano izquierda", "side", `${wiktionary("mano_izquierda")} and ${wiktionary("left")}`, {
			position: "standalone",
		}),
		row("costado norte", "side", `${wiktionary("costado")} and ${wiktionary("norte")}`),
		row("del", "at", `${wiktionary("del")} and ${NACION}`),
		row("de la", "at", NACION),
		row("contiguo a", "beside", wiktionary("adjacent")),
		row("cerca de", "near", wiktionary("cerca_de")),
		row(
			"cerca de mí",
			"near_asker",
			"composed from the cerca de row and the first-person pronoun (Wiktionary https://en.wiktionary.org/wiki/m%C3%AD)",
			{ position: "standalone" }
		),
		row("frente a", "opposite", wiktionary("frente_a")),
		row("en", "in", wiktionary("en")),
	],
}
