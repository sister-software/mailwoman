/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resourceDictionaryPathBuilder } from "mailwoman/sdk/repo"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import * as custom from "../custom/custom.js"
import { generateFilenames, normalizeCell, NormalizeCellOptions } from "../helper.js"
import * as pelias from "../pelias/pelias.js"
import { WhosOnFirstPlacetype } from "./placetypes.js"

const dictPath = resourceDictionaryPathBuilder("whosonfirst")

export const placetypesDictionary = readdirSync(dictPath).filter((p) => !p.includes("."))

/**
 * Load a dictionary file.
 */
export function load(
	set: Set<string>,
	placetypes: Iterable<WhosOnFirstPlacetype>,
	filenamePatterns: string[],
	options: NormalizeCellOptions
) {
	const add = _add(set, options)
	const remove = _remove(set, options)

	for (const placetype of placetypes) {
		const directory = dictPath(placetype)

		const filenames = generateFilenames(directory, filenamePatterns)

		for (const filename of filenames) {
			const filepath = directory(filename)

			if (!existsSync(filepath)) {
				continue
			}

			const dict = readFileSync(filepath, "utf8")
			const rows = dict.split("\n")

			rows.forEach((row) => {
				const cells = row.split("|") as WhosOnFirstPlacetype[]

				cells.forEach(add)
			})
		}
	}

	for (const placetype of placetypes) {
		pelias.load({ directory: path.join("whosonfirst", placetype), filenames: filenamePatterns }, add, remove)
	}

	for (const placetype of placetypes) {
		custom.load({ directory: path.join("whosonfirst", placetype), filenames: filenamePatterns }, add, remove)
	}
}

function _add(set: Set<string>, options: NormalizeCellOptions) {
	return (cell: string) => {
		const value = normalizeCell(cell, options)
		if (value && value.length) {
			set.add(value)
		}
	}
}

function _remove(set: Set<string>, options: NormalizeCellOptions) {
	return (cell: string) => {
		const value = normalizeCell(cell, options)
		if (value && value.length) {
			set.delete(value)
		}
	}
}
