/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Alpha3bLanguageCode } from "@mailwoman/core/resources/languages"
import { TextNormalizer } from "@mailwoman/core/tokenization"
import FastGlob, { type Entry } from "fast-glob"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import type { Displayable } from "../debugging.js"
import { ResourceMapCache } from "../ResourceMapCache.js"
import { DisposableSet } from "../set.js"
import { parsePlacetypeSource } from "./placetypes/admin.js"

/**
 * Index mapping a specific value to originating languages.
 *
 * If a value is present in this index, it means that the value is a valid value in at least one language.
 */
export type WhosOnFirstLocaleIndex = Map<string, Set<string>>
export type ReadonlyWhosOnFirstIndex = ReadonlyMap<string, ReadonlySet<string>>

export interface WOFCacheOptions {
	dataDirectory: PathBuilderLike
	internalDataDirectory: PathBuilderLike
	patterns: string[]
	normalizer: TextNormalizer
	blacklist?: Set<string>
}

/**
 * Index mapping a specific **placename** to its originating languages.
 *
 * If a value is present in this index, it means that the value is a valid in at least one language.
 */
export class WOFPlacenameCache extends ResourceMapCache<string, DisposableSet<Alpha3bLanguageCode>> {
	normalizer: TextNormalizer
	blacklist?: Set<string>
	dataDirectory: PathBuilder
	internalDataDirectory: PathBuilder
	patterns: string[]

	public override displayName = "wof"

	constructor(options: WOFCacheOptions) {
		super((_placename: string) => {
			const nextLanguageSet: Displayable<DisposableSet<Alpha3bLanguageCode>> = new DisposableSet<Alpha3bLanguageCode>()

			nextLanguageSet.displayName = this.displayName

			return nextLanguageSet
		})

		this.normalizer = options?.normalizer
		this.blacklist = options?.blacklist
		this.dataDirectory = PathBuilder.from(options.dataDirectory)
		this.internalDataDirectory = PathBuilder.from(options.internalDataDirectory)
		this.patterns = options.patterns
	}

	/**
	 * Add a collection of language codes to a placename.
	 *
	 * @param placename The placename to add.
	 * @param languageCodes The language codes to add.
	 */
	public add(placename: string, ...languageCodes: Alpha3bLanguageCode[]) {
		if (this.normalizer) {
			placename = this.normalizer.normalize(placename)

			if (!this.normalizer.validate(placename)) return
		}

		if (!placename) return

		if (this.blacklist?.has(placename)) return

		const placenameIndex = this.open(placename)

		for (const language of languageCodes) {
			placenameIndex.add(language)
		}
	}

	/**
	 * Remove a placename from the index.
	 *
	 * @param placename The placename to remove.
	 */
	public remove(placename: string): void {
		if (this.normalizer) {
			placename = this.normalizer.normalize(placename)
		}

		if (!placename) return

		this.close(placename)
	}

	public async ready(): Promise<this> {
		await this.marshall(this.patterns, this.dataDirectory)
		await this.marshall(this.patterns, this.internalDataDirectory)

		return this
	}

	public async marshall(filePatterns: string[], dataDirectory: PathBuilder): Promise<void> {
		const globStream = FastGlob.stream(filePatterns, {
			cwd: dataDirectory.toString(),
			absolute: true,
			objectMode: true,
		}) as AsyncIterable<Entry>

		for await (const fileEntry of globStream) {
			const { languageCode = "eng" } = parsePlacetypeSource(fileEntry.name)

			const lines = TextSpliterator.fromAsync(fileEntry.path)

			for await (const line of lines) {
				const row = line.trim()

				if (!row.length) continue
				const firstCharacter = row[0]

				// Skip comments.
				if (firstCharacter === "#") continue

				// Are we removing a placename?
				if (firstCharacter === "!") {
					for (const placename of row.slice(1).split("|")) {
						this.remove(placename)
					}

					continue
				}

				for (const placename of row.split("|")) {
					this.remove(placename)
					this.add(placename, languageCode)
				}
			}
		}
	}

	public toJSON() {
		const entries: Array<[string, Alpha3bLanguageCode[]]> = []

		for (const [placename, languages] of this) {
			entries.push([placename, Array.from(languages)])
		}

		return entries
	}
}
