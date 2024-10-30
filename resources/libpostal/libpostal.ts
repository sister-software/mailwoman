/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resourceDictionaryPathBuilder } from "mailwoman/sdk/repo"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import pluralize from "pluralize"
import * as custom from "../custom/custom.js"
import { normalizeCell, NormalizeCellOptions } from "../helper.js"
import * as pelias from "../pelias/pelias.js"

const dictPath = resourceDictionaryPathBuilder("libpostal")
// console.log("Dictionary path:", dictPath)

export const languages = new Set(readdirSync(dictPath).filter((p) => !p.includes(".")))

// console.log(`Found ${languages.size} languages:`, languages)

export interface Cell {
	langs: Record<string, boolean>
}

export type PostalIndex = Record<string, Cell>

/**
 * Load a dictionary file.
 */
export function load(index: PostalIndex, langs: Iterable<string>, filename: string, options?: NormalizeCellOptions) {
	const add = _add(index, options)
	const remove = _remove(index, options)

	// console.debug("Loading dictionary file:", filename)

	for (const lang of langs) {
		const filepath = dictPath(lang, filename).toString()
		// console.debug("Loading dictionary file:", filepath)

		if (!existsSync(filepath)) {
			// console.debug("Dictionary file not found:", filepath)
			continue
		}

		const dict = readFileSync(filepath, "utf8")

		dict.split("\n").forEach((row) => {
			row.split("|").forEach((cell) => add(lang, cell))
		})
	}

	for (const lang of langs) {
		pelias.load(path.join("libpostal", lang, filename), (value) => add(lang, value), remove)
	}

	for (const lang of langs) {
		custom.load(path.join("libpostal", lang, filename), (value) => add(lang, value), remove)
	}
}

type Adder = (lang: string, cell: string) => void

/**
 * Create an adder function.
 */
function _add(index: PostalIndex, options?: NormalizeCellOptions): Adder {
	return (lang, cell) => {
		const value = normalizeCell(cell, options)
		if (value && value.length) {
			index[value] = index[value] || { langs: {} }
			index[value].langs[lang] = true
		}
	}
}

type Remover = (cell: string) => void

/**
 * Create a remover function.
 */
function _remove(index: PostalIndex, options?: NormalizeCellOptions): Remover {
	return (cell) => {
		const value = normalizeCell(cell, options)

		if (value && value.length) {
			delete index[value]
		}
	}
}

// This functionality is only currently available for English
// see: https://github.com/plurals/pluralize
// @todo: find similar libraries which cover other languages
/**
 * Generate plurals for the index.
 */
export function generatePlurals(index: PostalIndex) {
	for (const [cell, value] of Object.entries(index)) {
		if (!value.langs.en) continue

		const plural = pluralize(cell)
		index[plural] = index[plural] || { langs: {} }
		index[plural].langs.en = true
	}
}
