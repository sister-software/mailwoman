/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Audits a held-out dataset for overlap with the named training corpora and writes the `--provenance` file
 *   `heldout/per/country.run.ts` reads.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/overlap.run.ts \
 *     --dataset <dataset manifest .json> --corpora <corpus MANIFEST.json>,<corpus MANIFEST.json> \
 *     --model-cards <published model-card.json>,<candidate model-card.json> \
 *     [--candidate-model-card <candidate model-card.json>] --out <provenance .json> \
 *     [--path-root /mnt/mw] [--verify-file-sha256]
 *
 *   Name the candidate's corpus, the published model's corpus, and every earlier corpus either was trained on.
 *   Each training file is read through DuckDB projecting only the id columns. A partial read is refused.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { readHeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import { auditHeldoutOverlap } from "#tools/eval-harness/heldout/dataset/overlap"

const { values } = parseArguments({
	options: {
		dataset: { type: "string", description: "The held-out dataset manifest" },
		corpora: {
			type: "string",
			description: "Training corpus MANIFEST.json files, comma-separated",
		},
		"model-cards": {
			type: "string",
			description: "Model cards of the compared models, comma-separated",
		},
		"candidate-model-card": {
			type: "string",
			description: "Which of --model-cards is the candidate's, for the unseen_by_candidate class",
		},
		"path-root": {
			type: "string",
			default: "/mnt/mw",
			description: "Local directory for a manifest's /data prefix",
		},
		"verify-file-sha256": {
			type: "boolean",
			description: "Recompute every training file's sha256",
		},
		out: { type: "string", description: "Where to write the provenance file" },
	},
})

if (!values.dataset || !values.corpora || !values.out) {
	throw new Error("--dataset, --corpora and --out are required")
}

const split = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0)

const result = await auditHeldoutOverlap({
	dataset: await readHeldoutDatasetManifest(values.dataset),
	corpora: split(values.corpora),
	modelCards: split(values["model-cards"]),
	...(values["candidate-model-card"] ? { candidateModelCard: values["candidate-model-card"] } : {}),
	pathRoot: values["path-root"],
	verifyFileSHA256: values["verify-file-sha256"] === true,
})

await writeLocalJSONFile(result, values.out)

for (const corpus of result.audit.corpora) {
	const read = corpus.files.filter((file) => file.read)

	console.log(
		`${corpus.corpusVersion ?? corpus.manifest}: read ${read.length} files (${read.reduce((n, f) => n + f.rows, 0)} rows), ` +
			`skipped ${corpus.files.length - read.length} test files`
	)

	for (const file of corpus.files) {
		console.log(`  ${file.read ? "read" : "skip"}\t${file.split}\t${file.rows}\t${file.matches}\t${file.path}`)
	}
}

for (const card of result.audit.modelCards) {
	console.log(`card ${card.path}: ${card.corpusVersion ?? "no corpus"} ${card.matched ? "matched" : card.problem}`)
}

console.log(
	`verified_unseen ${result.audit.counts.verified_unseen}, unseen_by_candidate ${result.audit.counts.unseen_by_candidate}, ` +
		`known_overlap ${result.audit.counts.known_overlap}, ` +
		`unknown ${result.audit.counts.unknown}`
)

for (const reason of result.audit.reasons) {
	console.log(`  verified_unseen refused: ${reason}`)
}
