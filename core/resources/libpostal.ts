// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Alpha2LanguageCode } from "mailwoman/core/resources/languages"
import { TextNormalizer, TextNormalizerInit } from "mailwoman/core/tokenization"
import { resourceDictionaryPathBuilder } from "mailwoman/sdk/repo"
import { readdir } from "node:fs/promises"
import { PathBuilder } from "path-ts"
import pluralize from "pluralize"
import { TextSpliterator } from "spliterator"
import { checkIfExists } from "./fs.js"
import { LocaleIndex } from "./LocaleIndex.js"

const libPostalDataDirectory = resourceDictionaryPathBuilder("libpostal")
const libPostalInternalDataDirectory = resourceDictionaryPathBuilder("internal", "libpostal")

export type LibPostalLanguageCode = Alpha2LanguageCode | "all"

export const availableLanguages = await readdir(libPostalDataDirectory).then((directories) => {
	const languageCodeDirectories = new Set<string>()

	for (const directory of directories) {
		if (directory.includes(".")) continue

		languageCodeDirectories.add(directory)
	}

	return Array.from(languageCodeDirectories) as LibPostalLanguageCode[]
})

export type LibPostalFileEntry = [filePath: string, languageCode: LibPostalLanguageCode]

/**
 * Given a filename and a list of selected language codes, return all matching files.
 */
async function findFilesMatchingLocale(
	filename: string,
	dataDirectory: PathBuilder,
	languageCodes: LibPostalLanguageCode[]
): Promise<LibPostalFileEntry[]> {
	const matches: LibPostalFileEntry[] = []

	await Promise.all(
		Array.from(languageCodes, async (languageCode) => {
			const filePath = dataDirectory(languageCode, filename).toString()
			const exists = await checkIfExists(filePath)

			if (!exists) return

			matches.push([filePath, languageCode])
		})
	)

	return matches
}

interface LibPostalNormalizerInit extends TextNormalizerInit {
	pluralize?: boolean
}

/**
 * Load a dictionary file.
 */
export async function prepareLocaleIndex(
	/**
	 * An iterable of language codes
	 */
	languageCodes: LibPostalLanguageCode[] = availableLanguages,
	filename: string,
	options?: LibPostalNormalizerInit
): Promise<LocaleIndex<LibPostalLanguageCode>> {
	const normalizer = new TextNormalizer(options)
	const index = new LocaleIndex<LibPostalLanguageCode>([], {
		displayName: "libpostal",
		normalizer,
	})

	const fileEntries = await findFilesMatchingLocale(filename, libPostalDataDirectory, languageCodes)

	const internalFileEntries = await findFilesMatchingLocale(filename, libPostalInternalDataDirectory, languageCodes)

	await Promise.all(
		Array.from(fileEntries, async ([filePath, languageCode]) => {
			const lines = TextSpliterator.fromAsync(filePath)

			for await (const line of lines) {
				for (const entry of TextSpliterator.from(line, { delimiter: "|" })) {
					index.add(entry, languageCode)
				}
			}
		})
	)

	await Promise.all(
		Array.from(internalFileEntries, async ([filePath, languageCode]) => {
			const lines = TextSpliterator.fromAsync(filePath)

			for await (const line of lines) {
				if (!line) continue

				const firstCharacter = line[0]
				// Skip comments.
				if (firstCharacter === "#") continue

				if (firstCharacter === "!") {
					for (const entry of TextSpliterator.from(line.slice(1), { delimiter: "|" })) {
						index.remove(entry)
					}

					continue
				}

				for (const entry of TextSpliterator.from(line, { delimiter: "|" })) {
					index.add(entry, languageCode)
				}
			}
		})
	)

	if (index.size === 0) {
		throw new Error(
			`No index matches found for ${filename} in ${libPostalDataDirectory} for languages ${languageCodes}`
		)
	}

	if (options?.pluralize) {
		generatePlurals(index)
	}

	return index
}

/**
 * Generate plurals for the index.
 */
export function generatePlurals(index: LocaleIndex<LibPostalLanguageCode>) {
	for (const [singularCell, value] of index) {
		if (!value.has("en")) continue

		const plural = pluralize(singularCell)

		const cell = index.open(plural)

		cell.add("en")
	}
}
