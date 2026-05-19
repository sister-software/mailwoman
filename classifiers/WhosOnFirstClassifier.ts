/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	type Classification,
	PhraseClassifier,
	Span,
	TextNormalizer,
	type WhosOnFirstPlacetype,
	WOFPlacenameCache,
} from "@mailwoman/core"

import { resourceDictionaryPathBuilder } from "@mailwoman/core/utils"
const wofPlacetypeDictionary = resourceDictionaryPathBuilder("whosonfirst")
const wofInternalPlacetypeDictionary = resourceDictionaryPathBuilder("internal", "whosonfirst")

const WOFNormalizer = new TextNormalizer({
	lowercase: true,
	removeHyphen: true,
	removeAccents: true,
	minLength: 2,
})

export interface WhosOnFirstPlacetypeConfig {
	files: string[]
	classifications: Classification[]
}

// Note: These should be defined from most granular to least granular.
const placetypeConfigMap = new Map<WhosOnFirstPlacetype, WhosOnFirstPlacetypeConfig>([
	[
		"locality",
		{
			files: ["name:*_x_preferred.txt"],
			classifications: ["area", "locality"],
		},
	],
	[
		"region",
		{
			files: ["abrv:*_x_preferred.txt", "name:*_x_preferred.txt"],
			classifications: ["area", "region"],
		},
	],

	[
		"country",
		{
			files: ["name:*_x_preferred.txt", "wof:country.txt", "wof:country_alpha3.txt"],
			classifications: ["area", "country"],
		},
	],
])

const tokenBlacklist = new Set([
	// Cardinal directions
	"north",
	"south",
	"east",
	"west",

	// Generic placetype names
	"town",
	"street",
	"city",
	"king",
	// Stop words
	"at",
	"rue",

	// Ordinal numerics
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",

	"cafe",
	"small",
	"grand",
] as const)

const localityBlacklist = new Set([
	// ---
	"avenue",
	"lane",
	"terrace",
	"street",
	"road",
	"crescent",
	"furlong",
	"broadway",
])

export class WhosOnFirstClassifier extends PhraseClassifier {
	public placetypeToCacheMap = new Map<WhosOnFirstPlacetype, WOFPlacenameCache>()

	async ready(): Promise<this> {
		for (const [placetype, config] of placetypeConfigMap) {
			const placenameCache = new WOFPlacenameCache({
				patterns: config.files,
				normalizer: WOFNormalizer,
				blacklist: tokenBlacklist,
				dataDirectory: wofPlacetypeDictionary(placetype),
				internalDataDirectory: wofInternalPlacetypeDictionary(placetype),
			})

			await placenameCache.ready()

			this.placetypeToCacheMap.set(placetype, placenameCache)

			// Placetype specific modifications

			if (placetype === "locality") {
				const localityTokens = this.placetypeToCacheMap.get("locality")!
				// Remove locality names that sound like streets.

				for (const [token] of localityTokens) {
					const split = token.split(/\s/)
					const lastWord = split[split.length - 1]

					if (lastWord && localityBlacklist.has(lastWord)) {
						localityTokens.delete(token)
					}
				}
			}
		}

		return this
	}

	public explore(span: Span): void {
		if (span.is("stop_word") || span.children.first?.is("stop_word")) {
			return
		}

		const lastChild = span.children.last || span
		const { nextSibling } = lastChild

		if (nextSibling && (nextSibling.is("street_suffix") || nextSibling.is("place"))) {
			return
		}

		const firstChild = span.children.first || span
		const { previousSibling } = firstChild

		let confidence: number | undefined

		if (previousSibling) {
			if (previousSibling.is("intersection")) return

			if (previousSibling.is("stop_word")) {
				confidence = 0.5
			}
		}

		const normalizedPlacename = WOFNormalizer.normalize(span.normalized)

		if (!normalizedPlacename) return

		for (const [placetype, placetypeConfig] of placetypeConfigMap) {
			const placetypeTokens = this.placetypeToCacheMap.get(placetype)

			if (!placetypeTokens) continue

			const languages = placetypeTokens.get(normalizedPlacename)

			if (!languages) continue

			// Finally, we add the classifications.
			for (const classification of placetypeConfig.classifications) {
				span.classifications.add({
					classification,
					confidence,
					languages,
				})
			}
		}
	}
}
