/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Draws a country's training rows from a complete adapter output, stratified across localities, forms and
 *   postcodes and capped so no country dominates a mixture, and prints the variety measures of the full output and
 *   of the sample. The report is written beside the sample as `<output>.variety.json`. The adapter output is left
 *   complete, because retrieval reads it whole.
 *
 *   Usage:
 *   node --max-old-space-size=8192 packages/mailwoman/tools/dev-tools/corpus/variety-sample.run.ts \
 *     --input <adapter dir>/canonical.jsonl --output <recipe outputs>/<source>.jsonl --country RS \
 *     [--ceiling 50000] [--per-place 100] [--per-street 2] [--seed 20261017]
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { writeVarietySample } from "@mailwoman/corpus/tools/variety-sample"

const { values } = parseArguments({
	options: {
		input: { type: "string", description: "Complete adapter output (canonical JSONL)" },
		output: { type: "string", description: "Sample JSONL to write" },
		country: { type: "string", description: "ISO 3166-1 alpha-2 code of the rows to keep" },
		ceiling: { type: "string", description: "Most rows for the country (default 50000)" },
		"per-place": {
			type: "string",
			description: "Most rows from one locality and dependent-locality pair (default 100)",
		},
		"per-street": { type: "string", description: "Most rows from one street in one locality (default 2)" },
		seed: { type: "string", description: "Shuffle seed (default 20261017)" },
	},
})

if (!values.input || !values.output || !values.country) {
	throw new Error("usage: variety-sample.run.ts --input <canonical.jsonl> --output <sample.jsonl> --country <CC>")
}

function readCountFlag(name: string, value: string | undefined, fallback: number): number {
	const parsed = Number(value ?? fallback)

	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer, read ${value}`)

	return parsed
}

const report = await writeVarietySample({
	input: values.input,
	output: values.output,
	country: values.country,
	limits: {
		ceiling: readCountFlag("ceiling", values.ceiling, 50_000),
		perPlace: readCountFlag("per-place", values["per-place"], 100),
		perStreet: readCountFlag("per-street", values["per-street"], 2),
		seed: readCountFlag("seed", values.seed, 20_261_017),
	},
})

const columns = [
	"rows",
	"localities",
	"dependentLocalities",
	"places",
	"postcodes",
	"streets",
	"streetTypes",
	"forms",
	"unitShare",
	"dependentLocalityShare",
	"streetlessShare",
	"postcodeShare",
	"largestLocalityShare",
] as const

console.log(["set", ...columns, "scripts"].join("\t"))

for (const [name, measures] of [
	["full", report.full],
	["sample", report.sample],
] as const) {
	console.log([name, ...columns.map((column) => measures[column]), stringifyJSON(measures.scripts)].join("\t"))
}

console.log(
	`coverage ${stringifyJSON(report.coverage)}; street types from ${stringifyJSON(report.streetTypeLanguages)}`
)
console.log(`wrote ${report.output} (${report.outputSHA256})`)
