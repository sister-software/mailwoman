/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Japan designators: the delivery service, premise, sub-premise, floor, block-numbering and relation words
 *   that a Japanese address or query uses. Floors come from the Japanese floor lexicon.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/jpnEn.pdf UPU Japan addressing profile}
 * @see {@link https://en.wiktionary.org/wiki/私書箱 Wiktionary 私書箱}
 * @see {@link https://en.wiktionary.org/wiki/棟 Wiktionary 棟}
 * @see {@link https://en.wiktionary.org/wiki/号館 Wiktionary 号館}
 * @see {@link https://en.wiktionary.org/wiki/ビル Wiktionary ビル}
 * @see {@link https://en.wiktionary.org/wiki/室 Wiktionary 室}
 * @see {@link https://en.wiktionary.org/wiki/階 Wiktionary 階}
 * @see {@link https://en.wiktionary.org/wiki/番地 Wiktionary 番地}
 * @see {@link https://en.wiktionary.org/wiki/近く Wiktionary 近く}
 * @see {@link https://en.wiktionary.org/wiki/駅前 Wiktionary 駅前}
 * @see {@link https://en.wiktionary.org/wiki/私 Wiktionary 私}
 */

import { JA_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorRow, type PostalDesignatorTable } from "#postal/designator"

import { JP_BLOCK_MARKERS } from "./address-unit.ts"

const UPU_JAPAN = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/jpnEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const BLOCK_MARKER_SOURCE: Record<(typeof JP_BLOCK_MARKERS)[number], string> = {
	丁目: UPU_JAPAN,
	番地: `${WIKTIONARY}番地`,
	番: UPU_JAPAN,
	号: UPU_JAPAN,
}

const FLOOR_SOURCE: Record<string, string> = {
	F: `${WIKTIONARY}階`,
	B: `${WIKTIONARY}地下`,
	RF: `${WIKTIONARY}屋上`,
}

const FLOOR_POSITION: Record<string, PostalDesignatorRow["position"]> = {
	F: "suffix",
	B: "prefix",
	RF: "standalone",
}

const FLOOR_ROWS: PostalDesignatorRow[] = designatorRowsFromLevels(JA_LEVEL_DESIGNATORS, {
	script: "Jpan",
	language: "ja",
	source: `${WIKTIONARY}階`,
}).map((row) => ({
	...row,
	position: FLOOR_POSITION[row.spelling] ?? row.position,
	source: FLOOR_SOURCE[row.spelling] ?? row.source,
}))

const BLOCK_NUMBERING_ROWS: PostalDesignatorRow[] = JP_BLOCK_MARKERS.map((marker) => ({
	spelling: marker,
	abbreviations: [],
	script: "Jpan",
	position: "suffix",
	concept: "block_numbering",
	language: "ja",
	source: BLOCK_MARKER_SOURCE[marker],
}))

/**
 * Japan's designator rows, each carrying the published list it was checked against.
 */
export const JP_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "JP",
	rows: [
		{
			spelling: "私書箱",
			abbreviations: ["郵便私書箱"],
			script: "Jpan",
			position: "prefix",
			concept: "post_office_box",
			language: "ja",
			source: `${WIKTIONARY}私書箱`,
		},
		{
			spelling: "棟",
			abbreviations: [],
			script: "Jpan",
			position: "suffix",
			concept: "building",
			language: "ja",
			source: `${WIKTIONARY}棟`,
		},
		{
			spelling: "号館",
			abbreviations: [],
			script: "Jpan",
			position: "suffix",
			concept: "building",
			language: "ja",
			source: `${WIKTIONARY}号館`,
		},
		{
			spelling: "ビル",
			abbreviations: ["ビルディング"],
			script: "Jpan",
			position: "suffix",
			concept: "building",
			language: "ja",
			source: UPU_JAPAN,
		},
		{
			spelling: "室",
			abbreviations: [],
			script: "Jpan",
			position: "suffix",
			concept: "room",
			language: "ja",
			source: `${WIKTIONARY}室`,
		},
		...FLOOR_ROWS,
		{
			spelling: "1-2-3",
			abbreviations: [],
			script: "Jpan",
			position: "infix",
			concept: "block_numbering",
			language: "ja",
			source: UPU_JAPAN,
		},
		...BLOCK_NUMBERING_ROWS,
		{
			spelling: "の近く",
			abbreviations: [],
			script: "Jpan",
			position: "suffix",
			concept: "near",
			language: "ja",
			source: `${WIKTIONARY}近く`,
		},
		{
			spelling: "近くの",
			abbreviations: [],
			script: "Jpan",
			position: "prefix",
			concept: "near",
			language: "ja",
			source: `${WIKTIONARY}近く`,
		},
		{
			spelling: "駅前",
			abbreviations: [],
			script: "Jpan",
			position: "suffix",
			concept: "at",
			language: "ja",
			source: `${WIKTIONARY}駅前`,
		},
		{
			spelling: "私の近く",
			abbreviations: [],
			script: "Jpan",
			position: "standalone",
			concept: "near_asker",
			language: "ja",
			source: `composed from the near row and the first-person pronoun (Wiktionary ${WIKTIONARY}私)`,
		},
	],
}
