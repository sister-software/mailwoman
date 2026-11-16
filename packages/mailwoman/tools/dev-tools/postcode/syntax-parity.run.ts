// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * States whether the training side's postcode tables hold the same patterns
 * as `@mailwoman/postcode` (#3064).
 *
 * `packages/trainer/data/postcode-syntax.json` is compared with the compiled country formats.
 * `postcodeSyntax` returns those formats for every country `postcodeSyntaxCountries` lists.
 *
 * The comparison uses the pattern source and the printed prefix.
 * The package's own reader supplies the package side, and the tool never parses
 * a libaddressinput pattern itself.
 *
 * `packages/trainer/data/postcode-shapes.json` is compared with
 * `packages/postcode/lib/shapes.json` as parsed JSON.
 * The Python trainer and the Rust finders read the first file as a vendored copy of the second.
 *
 * Usage: `node packages/mailwoman/tools/dev-tools/postcode/syntax-parity.run.ts`
 *
 * The tool prints one JSON report and exits non-zero when any row differs or either side lacks a country.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { postcodeSyntaxCountries } from "@mailwoman/postcode/country-formats"
import { postcodeSyntaxText } from "@mailwoman/postcode/country-formats/source"

interface SyntaxRow {
	pattern: string
	prefix: string | null
}

interface SyntaxRecord {
	countries: Record<string, SyntaxRow>
}

interface ShapesRecord {
	version: string
	shapes: unknown[]
}

const trainer = await readLocalJSONFile<SyntaxRecord>(
	repoRootPath("packages", "trainer", "data", "postcode-syntax.json")
)

const serving = postcodeSyntaxCountries()
const recorded = Object.keys(trainer.countries).toSorted()

const onlyServing = serving.filter((code) => !Object.hasOwn(trainer.countries, code))
const onlyTrainer = recorded.filter((code) => !serving.includes(code))

const differing = serving
	.filter((code) => Object.hasOwn(trainer.countries, code))
	.flatMap((code) => {
		const compiled = postcodeSyntaxText(code)

		if (!compiled) {
			throw new Error(`postcodeSyntaxCountries lists ${code} but postcodeSyntaxText(${code}) returned null`)
		}

		const row = trainer.countries[code]!
		const servingRow = { pattern: compiled.pattern, prefix: compiled.prefix }

		return row.pattern === servingRow.pattern && row.prefix === servingRow.prefix
			? []
			: [{ code, trainer: row, serving: servingRow }]
	})

const shapesTrainer = await readLocalJSONFile<ShapesRecord>(
	repoRootPath("packages", "trainer", "data", "postcode-shapes.json")
)

const shapesServing = await readLocalJSONFile<ShapesRecord>(workspacePath("postcode", "lib", "shapes.json"))
const shapesIdentical = stringifyJSON(shapesTrainer) === stringifyJSON(shapesServing)

console.log(
	prettyJSON({
		syntax: {
			servingCountries: serving.length,
			trainerCountries: recorded.length,
			onlyServing,
			onlyTrainer,
			differingRows: differing.length,
			differing,
		},
		shapes: {
			trainerVersion: shapesTrainer.version,
			servingVersion: shapesServing.version,
			trainerRows: shapesTrainer.shapes.length,
			servingRows: shapesServing.shapes.length,
			identical: shapesIdentical,
		},
	})
)

if (onlyServing.length || onlyTrainer.length || differing.length || !shapesIdentical) {
	process.exitCode = 1
}
