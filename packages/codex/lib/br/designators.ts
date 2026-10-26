/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Brazilian designators: caixa postal, premise and sub-premise words, floors, number marks and Portuguese
 *   relation words. The Correios sheet on the UPU site shows `Caixa Postal`, `CPC`, `Bloco`, `Conjunto`,
 *   `Quadra` and `8º andar`. The remaining words take a dictionary entry as their source.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/braEn.pdf UPU Brazil postal address sheet (Correios)}
 * @see {@link https://en.wiktionary.org/wiki/edif%C3%ADcio Wiktionary, edifício}
 * @see {@link https://en.wiktionary.org/wiki/sala Wiktionary, sala}
 * @see {@link https://en.wiktionary.org/wiki/casa Wiktionary, casa}
 * @see {@link https://en.wiktionary.org/wiki/lote Wiktionary, lote}
 * @see {@link https://en.wiktionary.org/wiki/s%2Fn Wiktionary, s/n}
 * @see {@link https://en.wiktionary.org/wiki/perto_de Wiktionary, perto de}
 * @see {@link https://en.wiktionary.org/wiki/em Wiktionary, em}
 * @see {@link https://en.wiktionary.org/wiki/apto Wiktionary, apto}
 * @see {@link https://en.wiktionary.org/wiki/km Wiktionary, km}
 * @see {@link https://en.wiktionary.org/wiki/ground_floor Wiktionary, ground floor (translations)}
 * @see {@link https://en.wiktionary.org/wiki/basement Wiktionary, basement (translations)}
 * @see {@link https://en.wiktionary.org/wiki/penthouse Wiktionary, penthouse (translations)}
 * @see {@link https://en.wiktionary.org/wiki/next_to Wiktionary, next to (translations)}
 * @see {@link https://en.wiktionary.org/wiki/mim Wiktionary, mim}
 */

import { PT_LEVEL_DESIGNATORS } from "#level-semantics"
import {
	designatorRowsFromLevels,
	type DesignatorConcept,
	type PostalDesignatorRow,
	type PostalDesignatorTable,
} from "#postal-designator"

const UPU = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/braEn.pdf"

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
		language: "pt",
		source,
	}
}

const FLOOR_ROWS = designatorRowsFromLevels(
	PT_LEVEL_DESIGNATORS.filter((level) => level.code === "ANDAR"),
	{ script: "Latn", language: "pt", source: UPU, position: "suffix" }
).map((floor) => ({ ...floor, spelling: "andar" }))

/**
 * The Brazilian designator table, read from the UPU sheet for Correios and dictionary entries.
 */
export const BR_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "BR",
	rows: [
		row("Caixa Postal", "post_office_box", UPU),
		row("CPC", "special_routing", UPU),
		row("Edifício", "building", wiktionary("edif%C3%ADcio")),
		row("Bloco", "block", UPU, { abbreviations: ["BL"] }),
		row("Conjunto", "building", UPU, { abbreviations: ["CJ"] }),
		row("Quadra", "block", UPU, { abbreviations: ["Q"] }),
		row("Apto.", "apartment", wiktionary("apto"), { abbreviations: ["Apartamento"] }),
		row("Sala", "room", wiktionary("sala")),
		row("Casa", "unit", wiktionary("casa")),
		row("Lote", "unit", wiktionary("lote")),
		...FLOOR_ROWS,
		row("Térreo", "ground_floor", wiktionary("ground_floor"), { position: "standalone" }),
		row("Subsolo", "basement", wiktionary("basement"), { position: "standalone" }),
		row("Cobertura", "penthouse", wiktionary("penthouse"), { position: "standalone" }),
		row("Km", "number_sign", wiktionary("km")),
		row("º", "ordinal_mark", UPU, { position: "suffix" }),
		row("S/N", "number_sign", wiktionary("s%2Fn"), { position: "standalone" }),
		row("perto de", "near", wiktionary("perto_de")),
		row(
			"perto de mim",
			"near_asker",
			"composed from the perto de row and the first-person pronoun (Wiktionary https://en.wiktionary.org/wiki/mim)",
			{ position: "standalone" }
		),
		row("ao lado de", "beside", wiktionary("next_to")),
		row("em", "in", wiktionary("em")),
	],
}
