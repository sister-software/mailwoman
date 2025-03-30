// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { resourceDictionaryPathBuilder } from "mailwoman/sdk/repo"
import { TextNormalizer } from "../tokenization/normalizer.js"
import { WithDisplayable } from "./debugging.js"
import { ResourceMapCache } from "./ResourceMapCache.js"
import { DisposableSet } from "./set.js"

const dictPath = resourceDictionaryPathBuilder("libpostal")

const libPostalDictionary = resourceDictionaryPathBuilder("libpostal")
const wofInternalPlacetypeDictionary = resourceDictionaryPathBuilder("internal", "whosonfirst")

/**
 * Options for the locale index.
 */
export interface LocaleIndexOptions {
	displayName: string
	normalizer?: TextNormalizer
}

/**
 * Index mapping a specific value to originating languages.
 *
 * If a value is present in this index, it means that the value is a valid value in at least one
 * language.
 */
export class LocaleIndex<LanguageCodes extends string> extends ResourceMapCache<
	string,
	WithDisplayable<DisposableSet<LanguageCodes>>
> {
	public readonly normalizer?: TextNormalizer
	/**
	 * The source of the index.
	 */
	public override displayName: string

	constructor(entries: Iterable<readonly [string, Iterable<LanguageCodes>]> = [], options: LocaleIndexOptions) {
		super((_placename: string) => new DisposableSet<LanguageCodes>())

		this.displayName = options?.displayName ?? "unknown"
		this.normalizer = options?.normalizer

		for (const [placename, languageCodes] of entries) {
			this.add(placename, ...languageCodes)
		}
	}

	/**
	 * Add a placename to the index, associating it with the given language codes.
	 *
	 * @param placename The placename to add.
	 * @param languageCodes The language codes to associate with the placename.
	 */
	public add(placename: string, ...languageCodes: LanguageCodes[]): void {
		if (languageCodes.length === 0) {
			throw new Error(`At least one language code must be provided for "${placename}".`)
		}

		if (this.normalizer) {
			placename = this.normalizer.normalize(placename)

			if (!this.normalizer.validate(placename)) return
		}

		if (!placename) return

		const placenameIndex = this.open(placename)
		placenameIndex.displayName = this.displayName

		for (const language of languageCodes) {
			placenameIndex.add(language)
		}
	}

	/**
	 * Remove a placename from the index.
	 *
	 * @param placename The placename to remove.
	 */
	public remove(placename: string) {
		if (this.normalizer) {
			placename = this.normalizer.normalize(placename)
		}

		if (!placename) return

		this.close(placename)
	}

	/**
	 * Get the language codes associated with a placename.
	 */
	public override get(placename: string): DisposableSet<LanguageCodes> | undefined {
		return super.get(placename)
	}

	/**
	 * Serialize the index to JSON.
	 */
	public override toJSON() {
		const entries: Array<[string, LanguageCodes[]]> = []

		for (const [placename, languages] of this) {
			entries.push([placename, Array.from(languages)])
		}

		return entries
	}
}
