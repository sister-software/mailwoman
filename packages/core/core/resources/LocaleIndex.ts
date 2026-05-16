/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { TextNormalizer } from "../tokenization/normalizer.js"
import { Displayable } from "./debugging.js"

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
export class LocaleIndex<LanguageCodes extends string> extends Map<string, Set<LanguageCodes>> {
	/**
	 * The normalizer to use for placenames.
	 */
	public readonly normalizer?: TextNormalizer

	/**
	 * The source of the index.
	 */
	public displayName: string

	constructor(entries: Iterable<readonly [string, Iterable<LanguageCodes>]> = [], options: LocaleIndexOptions) {
		super()

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

		super.delete(placename)
	}

	public open(placename: string): Displayable<Set<LanguageCodes>> {
		if (this.normalizer) {
			placename = this.normalizer.normalize(placename)
		}

		if (!placename) {
			throw new Error(`Placename "${placename}" is empty or invalid.`)
		}

		let placenameIndex: Displayable<Set<LanguageCodes>> | undefined = this.get(placename)

		if (!placenameIndex) {
			placenameIndex = new Set<LanguageCodes>()
			this.set(placename, placenameIndex)
		}

		return placenameIndex
	}

	/**
	 * Get the language codes associated with a placename.
	 */
	declare get: (placename: string) => Displayable<Set<LanguageCodes>> | undefined

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
