/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type PostcodeSpec, Span, WordClassifier } from "@mailwoman/core"
import { corePackagePathBuilder } from "@mailwoman/core/utils"
import { readFile } from "node:fs/promises"

const dictPath = corePackagePathBuilder("data", "chromium-i18n", "ssl-address")

const DefaultPostcodeCountries: readonly string[] = [
	// ---
	"US",
	"GB",
	"FR",
	"DE",
	"ES",
	"PT",
	"AU",
	"NZ",
	"KR",
	"JP",
	"IN",
	"RU",
	"BR",
	"NL",
	"PL",
]

export class PostcodeClassifier extends WordClassifier {
	public postcodePatterns: RegExp[] = []
	protected countryCodes: Iterable<string> = []

	constructor(specs: Iterable<string> = DefaultPostcodeCountries) {
		super()

		this.countryCodes = specs
	}

	async ready(): Promise<this> {
		const patterns = await Promise.all(
			Iterator.from(this.countryCodes).map(async (cc) => {
				const countryDictPath = dictPath(`${cc.toUpperCase()}.json`)

				const spec: PostcodeSpec = await readFile(countryDictPath, "utf8").then(JSON.parse)

				const pattern = new RegExp("^(" + spec.zip + ")$", "i")

				return pattern
			})
		)

		this.postcodePatterns = patterns
			// remove countries with 3-digit postcodes
			.filter((row) => !row.test("100"))

		return this
	}

	public explore(span: Span): void {
		if (!span.flags.has("numeral")) return

		// Skip postcodes in the start position unless it's the only token in the section.
		if (span.is("start_token") && (span.previousSiblings.size > 0 || span.nextSiblings.size > 0)) {
			return
		}

		for (const pattern of this.postcodePatterns) {
			if (pattern.test(span.normalized)) {
				span.classifications.add("postcode")
				break
			}
		}
	}
}
