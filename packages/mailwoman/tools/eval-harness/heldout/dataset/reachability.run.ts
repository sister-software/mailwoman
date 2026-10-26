/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts, for each candidate vocabulary, the gold span edges of a frozen held-out dataset that fall inside one
 *   of its pieces, and writes one census per vocabulary.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/reachability.run.ts \
 *     --dataset <dataset manifest .json> --tokenizers <tokenizer.model>,<tokenizer.model> --out <report .json>
 *
 *   The command exits 1 when any vocabulary leaves an edge at a character-class change unreachable.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { censusReachability } from "#tools/eval-harness/heldout/dataset/reachability"

const { values } = parseArguments({
	options: {
		dataset: { type: "string", description: "The held-out dataset manifest" },
		tokenizers: {
			type: "string",
			description: "SentencePiece tokenizer.model files, comma-separated",
		},
		out: { type: "string", description: "Where to write the census report" },
	},
})

if (!values.dataset || !values.tokenizers || !values.out) {
	throw new Error("--dataset, --tokenizers and --out are required")
}

const { manifest, rows } = await readHeldoutDatasetRows(values.dataset)
const censuses = []

for (const path of values.tokenizers.split(",").map((p) => p.trim())) {
	const tokenizer = await MailwomanTokenizer.loadFromFile(path)
	const census = censusReachability(rows, tokenizer)
	const pieces = Object.entries(census.byPiece).toSorted((a, b) => b[1] - a[1])

	console.log(
		`${path}: ${census.unreachableAtClassChange} of ${census.edges} gold edges at a character-class change fall inside a piece ` +
			`(${census.unreachable} counting edges inside a letter run), over ${census.rows - census.characterPathRows} rows ` +
			`(${census.characterPathRows} character-path rows left out)`
	)
	console.log(`  by edge class: ${stringifyJSON(census.byEdgeClass)}`)
	console.log(
		`  top pieces: ${pieces
			.slice(0, 12)
			.map(([p, n]) => `${p} ${n}`)
			.join(", ")}`
	)

	censuses.push({
		tokenizer: path,
		...census,
		byPiece: Object.fromEntries(pieces),
	})
}

await writeLocalJSONFile(
	{
		dataset: {
			path: values.dataset,
			datasetID: manifest.datasetID,
			version: manifest.version,
		},
		censuses,
	},
	values.out
)

process.exitCode = censuses.some((c) => c.unreachableAtClassChange > 0) ? 1 : 0
