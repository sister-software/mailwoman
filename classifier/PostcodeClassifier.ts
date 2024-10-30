/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readFileSync } from "fs"
import { repoRootPathBuilder } from "mailwoman/sdk/repo"
import PostcodeClassification from "../classification/PostcodeClassification.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

const dictPath = repoRootPathBuilder("resources", "chromium-i18n", "ssl-address")

// postcode data sourced from google-i18n project
// see: https://chromium-i18n.appspot.com/ssl-address
// note: reducing the list of country codes will have a performance benefit
// const countryCodes = fs.readdirSync(dictPath)
//   .filter(p => p.endsWith('.json'))
//   .map(p => p.split('.')[0])
const countryCodes = [
	// ---
	"us",
	"gb",
	"fr",
	"de",
	"es",
	"pt",
	"au",
	"nz",
	"kr",
	"jp",
	"in",
	"ru",
	"br",
	"nl",
	"pl",
]

export interface DataEntry {
	zip: string
	regex: RegExp
}

class PostcodeClassifier extends WordClassifier {
	public data: DataEntry[] = []

	constructor() {
		super()

		this.data = countryCodes
			.map((cc) => {
				const row: DataEntry = JSON.parse(readFileSync(dictPath(`${cc.toUpperCase()}.json`), "utf8"))

				row.regex = new RegExp("^(" + row.zip + ")$", "i")
				return row
			})
			.filter((row) => !row.regex.test("100")) // remove countries with 3-digit postcodes
	}

	each(span: Span) {
		// skip spans which do not contain numbers
		// @todo: is this correct globally?
		if (!span.contains.numerals) {
			return
		}

		// do not allow postcode in the start position unless it is the
		// only token present in its section
		if (
			span.classifications.hasOwnProperty("StartTokenClassification") &&
			(span.graph.length("prev") > 0 || span.graph.length("next") > 0)
		) {
			return
		}

		for (const entry of this.data) {
			if (entry.regex.test(span.norm)) {
				span.classify(new PostcodeClassification(1))
				break
			}
		}
	}
}

export default PostcodeClassifier
