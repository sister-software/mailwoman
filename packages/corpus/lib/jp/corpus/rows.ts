/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Renders one Japanese address row in one register and checks the record.
 *
 *   A register is one way of writing the same address, and most registers never occur in the source, so synthesis is
 *   their only route into the corpus. {@linkcode RowRenderer} records each span as it appends the field.
 *
 *   Ported from the Python builders' `countries/jp/corpora/rows.py`.
 */

import type { SeededRandom } from "@mailwoman/core/random"

import { type CJKRecord, labelTokensByFirstSpan, RowRenderer, verifyRecord } from "#cjk/builder"
import { intToKanji } from "#cjk/text"

/**
 * The label set the Japanese corpus is tagged against.
 */
export const JP_LABEL_SET_NAME = "stage3-jp"

/**
 * The corpus source string for these rows.
 * Configs use this value as the source weight key.
 */
export const JP_CORPUS_SOURCE = "overture-jp"

const COMPACT = /^[0-9]+(?:-[0-9]+)*$/u

/**
 * Each register's weight.
 *
 * The sampler renormalizes them over the registers a row can render.
 */
export const JP_REGISTER_WEIGHTS = new Map<string, number>([
	// The source's own surface: kanji chōme and a compact banchi-go number.
	["native", 0.4],
	// The chōme in Arabic numerals (二丁目 as 2丁目), which the source never writes.
	["arabic_chome", 0.25],
	// The chōme folded into the house number (八島町2-3-16).
	["compact_folded", 0.2],
	// The number written with designators (3番16号), which emits the sub_block and building_number tags.
	["designator", 0.15],
	// The municipality as its kana reading plus the kanji generic (あつぎ市), when `jp/kana` finds a reading.
	["kana_municipality", 0.05],
])

/**
 * The fields of one source row and the draws that decide its surface.
 */
export interface JPRenderInput {
	prefecture: string
	municipality: string
	district: string
	chome: number | null
	number: string
	postcode: string | null
	register: string
	spaced: boolean
	country: boolean
	hyphen?: string
	municipalityKana?: string | null
}

const POSTCODE_SPLIT = 3
const DESIGNATOR_PARTS = 2

/**
 * One row rendered in one register, largest component first, as a span-labeled corpus record.
 *
 * `spaced` puts one ASCII space between the admin components.
 * The 〒 mark sits outside the postcode span.
 *
 * @throws When the `kana_municipality` register has no kana reading.
 */
export function renderJPRow(input: JPRenderInput): CJKRecord {
	const renderer = new RowRenderer()
	const separator = input.spaced ? " " : ""
	const hyphen = input.hyphen ?? "-"

	if (input.postcode) {
		renderer.glue("〒")
		renderer.put("postcode", `${input.postcode.slice(0, POSTCODE_SPLIT)}-${input.postcode.slice(POSTCODE_SPLIT)}`)
		renderer.glue(" ")
	}

	if (input.country) {
		renderer.put("country", "日本")
		renderer.glue(separator)
	}

	renderer.put("prefecture", input.prefecture)
	renderer.glue(separator)

	if (input.register === "kana_municipality") {
		if (!input.municipalityKana) throw new Error("kana_municipality register needs municipality_kana")

		renderer.put("municipality", input.municipalityKana)
	} else {
		renderer.put("municipality", input.municipality)
	}

	renderer.glue(separator)

	const parts = input.number ? input.number.split("-") : []

	renderer.put("district", input.district)

	if (input.register === "compact_folded") {
		renderer.put("house_number", [String(input.chome), ...parts].join(hyphen))
	} else if (input.register === "designator") {
		if (input.chome !== null) {
			renderer.put("block", `${intToKanji(input.chome)}丁目`)
		}

		if (parts.length >= DESIGNATOR_PARTS) {
			renderer.put("sub_block", `${parts[0]}番`)
			renderer.put("building_number", `${parts[1]}号`)

			for (const extra of parts.slice(DESIGNATOR_PARTS)) {
				renderer.put("house_number", extra)
			}
		} else if (parts.length) {
			renderer.put("sub_block", `${parts[0]}番地`)
		}
	} else {
		if (input.chome !== null) {
			const chome = input.register === "arabic_chome" ? String(input.chome) : intToKanji(input.chome)

			renderer.put("block", `${chome}丁目`)
		}

		if (input.number) {
			renderer.put("house_number", parts.length ? parts.join(hyphen) : input.number)
		}
	}

	return {
		raw: renderer.raw,
		...labelTokensByFirstSpan(renderer.raw, renderer.starts, renderer.ends, renderer.tags),
		span_starts: renderer.starts,
		span_ends: renderer.ends,
		span_tags: renderer.tags,
		country: "JP",
		source: JP_CORPUS_SOURCE,
		register: input.register,
	}
}

/**
 * The registers a row can render.
 *
 * A number with a non-digit part (`362B-2`) renders only natively.
 * A row without a chōme also allows the designator register.
 * `kana` allows the kana-municipality register.
 */
export function availableJPRegisters(chome: number | null, number: string, kana = false): string[] {
	const clean = number ? COMPACT.test(number) : false
	const kanaExtra = kana ? ["kana_municipality"] : []

	if (!clean) return ["native", ...kanaExtra]

	if (chome === null) return ["native", "designator", ...kanaExtra]

	return [...JP_REGISTER_WEIGHTS.keys()].filter((name) => kana || name !== "kana_municipality")
}

/**
 * One of `options`, drawn by {@linkcode JP_REGISTER_WEIGHTS}.
 * A single option is returned without a draw.
 */
export function chooseJPRegister(rng: SeededRandom, options: readonly string[]): string {
	if (options.length === 1) return options[0]!

	return rng.weightedChoice(
		options,
		options.map((name) => JP_REGISTER_WEIGHTS.get(name)!)
	)
}

/**
 * {@linkcode verifyRecord} under {@linkcode JP_LABEL_SET_NAME}.
 */
export function verifyJPRecord(record: CJKRecord, tagSet: ReadonlySet<string>): void {
	verifyRecord(record, tagSet, { labelSetName: JP_LABEL_SET_NAME })
}
