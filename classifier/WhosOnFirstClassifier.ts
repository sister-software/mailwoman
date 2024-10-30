/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import AreaClassification from "../classification/AreaClassification.js"
import CountryClassification from "../classification/CountryClassification.js"
import PhraseClassifier from "./super/PhraseClassifier.js"
// const DependencyClassification = require('../classification/DependencyClassification')
import { ClassificationConstructor } from "../classification/Classification.js"
import LocalityClassification from "../classification/LocalityClassification.js"
import RegionClassification from "../classification/RegionClassification.js"
import { WhosOnFirstPlacetype } from "../resources/whosonfirst/placetypes.js"
import * as whosonfirst from "../resources/whosonfirst/whosonfirst.js"
import createNormalizer from "../tokenization/normalizer.js"
import { Span } from "../tokenization/Span.js"

const normalizer = createNormalizer({
	lowercase: true,
	removeHyphen: true,
	removeAccents: true,
})

export interface WhosOnFirstPlacetypeConfig {
	files: string[]
	classifications: ClassificationConstructor[]
}

// note: these should be defined from most granular to least granular
const placetypeConfigMap = new Map<WhosOnFirstPlacetype, WhosOnFirstPlacetypeConfig>([
	[
		"locality",
		{
			files: ["name:*_x_preferred.txt"],
			classifications: [AreaClassification, LocalityClassification],
		},
	],
	[
		"region",
		{
			files: ["abrv:*_x_preferred.txt", "name:*_x_preferred.txt"],
			classifications: [AreaClassification, RegionClassification],
		},
	],
	// [
	// 	"dependency",
	// 	{
	// 		files: ["wof:shortcode.txt", "name:eng_x_preferred.txt"],
	// 		classifications: [AreaClassification, DependencyClassification],
	// 	},
	// ],

	[
		"country",
		{
			files: ["name:*_x_preferred.txt", "wof:country.txt", "wof:country_alpha3.txt"],
			classifications: [AreaClassification, CountryClassification],
		},
	],
])

const tokenBlacklist = new Set([
	"north",
	"south",
	"east",
	"west",
	"street",
	"city",
	"king",
	"at",
	"rue",
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
	"town",
	"city",
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

class WhosOnFirstClassifier extends PhraseClassifier {
	public tokens = new Map<WhosOnFirstPlacetype, Set<string>>()

	constructor() {
		super()

		for (const [placetype, config] of placetypeConfigMap) {
			let placeTypeTokens = new Set<WhosOnFirstPlacetype>()

			whosonfirst.load(placeTypeTokens, [placetype], config.files, {
				minlength: 2,
				normalizer,
			})

			placeTypeTokens = placeTypeTokens.difference(tokenBlacklist)

			this.tokens.set(placetype, placeTypeTokens)

			// placetype specific modifications
			if (placetype === "locality") {
				const localityTokens = this.tokens.get("locality")!
				// remove locality names that sound like streets

				for (const token of localityTokens) {
					const split = token.split(/\s/)
					const lastWord = split[split.length - 1]

					if (lastWord && localityBlacklist.has(lastWord)) {
						localityTokens.delete(token)
					}
				}
			}
		}
	}

	each(span: Span) {
		let confidence = 1.0
		// do not classify tokens preceeded by an 'IntersectionClassification' or add a penality to 'StopWordClassification'
		const firstChild = span.graph.findOne("child:first") || span
		const prev = firstChild.graph.findOne("prev")

		if (prev) {
			if (Object.hasOwn(prev.classifications, "IntersectionClassification")) {
				return
			}

			if (Object.hasOwn(prev.classifications, "StopWordClassification")) {
				confidence = confidence / 2
			}
		}

		// do not classify tokens preceeding 'StreetSuffixClassification' or 'PlaceClassification'
		const lastChild = span.graph.findOne("child:last") || span
		const next = lastChild.graph.findOne("next")

		if (
			next &&
			(Object.hasOwn(next.classifications, "StreetSuffixClassification") ||
				Object.hasOwn(next.classifications, "PlaceClassification"))
		) {
			return
		}

		const normalizedSpan = normalizer(span.norm)

		for (const placetype of placetypeConfigMap.keys()) {
			const placetypeTokens = this.tokens.get(placetype)
			if (!placetypeTokens) continue

			if (placetypeTokens.has(normalizedSpan)) {
				// do not classify tokens if they already have a 'StopWordClassification'
				if (
					Object.hasOwn(span.classifications, "StopWordClassification") ||
					(span.graph.length("child") > 0 &&
						Object.hasOwn(span.graph.findOne("child")!.classifications, "StopWordClassification"))
				) {
					continue
				}

				// classify tokens
				placetypeConfigMap.get(placetype)!.classifications.forEach((Class) => {
					return span.classify(new Class(confidence))
				})
			}
		}
	}
}

export default WhosOnFirstClassifier
