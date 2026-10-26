/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the compiled postcode syntax of every country, and the code-unit parity fixture, for the Python side of
 *   the code-unit channel (#2845).
 *
 *   The training loader computes a code unit's accepting-country count from these patterns, and the inference feed
 *   computes it from `@mailwoman/postcode` directly. The fixture records the TypeScript features for a fixed set of
 *   inputs and piece spans, and the Python test reproduces them, so the two sides cannot drift.
 *
 *   Usage: `node packages/mailwoman/tools/dev-tools/postcode/code-unit-syntax.run.ts`
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { codeUnitChannel } from "@mailwoman/neural/code-unit-features"
import { postcodeSyntax, postcodeSyntaxCountries } from "@mailwoman/postcode/country-formats"

const countries = Object.fromEntries(
	postcodeSyntaxCountries().map((code) => {
		const syntax = postcodeSyntax(code)!

		return [code, { pattern: syntax.pattern.source, prefix: syntax.prefix }]
	})
)

await writeLocalTextFile(
	prettyJSON({
		$generatedBy: "packages/mailwoman/tools/dev-tools/postcode/code-unit-syntax.run.ts",
		$note: "Each pattern is anchored and matched case-insensitively against a value with its prefix removed.",
		countries,
	}),
	repoRootPath("corpus-python", "src", "mailwoman_train", "data", "postcode-syntax.json")
)

/**
 * Inputs whose whitespace pieces the fixture records, chosen to cover each feature and each boundary rule.
 */
const INPUTS = [
	"350 5th Ave, New York, NY 10118-0110",
	"10 Downing St, London SW1A 2AA",
	"〒100-0005 東京都千代田区丸の内1-9-1",
	"Calle Mayor 12, 28013 Madrid",
	"Unit 4B, 12-14 High St",
]

const cases = INPUTS.map((text) => {
	const spans = [...text.matchAll(/\S+/gu)].map(
		(match) => [match.index, match.index + match[0].length] as [number, number]
	)

	const channel = codeUnitChannel(text, spans)

	return { text, spans, features: channel.features, confidence: channel.confidence }
})

await writeLocalTextFile(prettyJSON({ cases }), repoRootPath("test", "fixtures", "code-unit-parity.json"))

console.log(`${Object.keys(countries).length} countries, ${cases.length} parity cases`)
