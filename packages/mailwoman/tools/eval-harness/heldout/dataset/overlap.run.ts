// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Audits a held-out dataset for overlap with the listed training corpora
 *   and writes the `--provenance` file `heldout/per/country.run.ts` reads.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/overlap.run.ts \
 *     --dataset <dataset manifest .json> --corpora <corpus MANIFEST.json>,<corpus MANIFEST.json> \
 *     --model-cards <published model-card.json>,<candidate model-card.json> \
 *     [--training-configs <config .yaml>,…] \
 *     [--candidate-model-card <candidate model-card.json>] --out <provenance .json> \
 *     [--path-root /mnt/mw] [--verify-file-sha256] [--match-text] [--match-address]
 *     [--preview-evaluation-groups <evaluation-groups.json>] [--refuse-overlap identity,group]
 *     [--duckdb-memory-gib 4] [--duckdb-threads 4]
 *
 *   `--match-address` compares the rows of a source whose group identity holds an address
 *   key (`GROUP_ADDRESS_KEY_SOURCES`, NAD) with that source's training rows by address key,
 *   so an address a re-ingest wrote under a new record id overlaps as `address`.
 *
 *   `--preview-evaluation-groups` leaves out every training row whose group or address
 *   key the list holds, as a re-split under that list would send it to `test`.
 *   The audit then describes the next corpus of the same rows rather than the corpus
 *   a model trained on, and records the list it previewed.
 *
 *   `--refuse-overlap` exits 1, after writing the provenance file, when a row overlaps
 *   training by one of the listed kinds, so a build step stops on a registered row in train.
 *   A kind the flag doesn't list, such as `text`, is reported and admitted.
 *
 *   `--match-text` also compares every training row's folded text with the
 *   dataset's row texts, read from its rows file.
 *   A dataset drawn from a source no corpus reads needs it, because identities
 *   and groups can't match across sources.
 *
 *   Name a model by `--training-configs` when its card's `training.corpus_version` is stale:
 *   the config's `data.corpus_dir` then identifies its corpus.
 *
 *   Name the candidate's corpus, the published model's corpus, and every earlier
 *   corpus either was trained on.
 *   Each training file is read through DuckDB projecting only the id columns.
 *   A partial read is refused.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { readEvaluationGroups } from "@mailwoman/corpus/utils/evaluation-groups"

import { readHeldoutDatasetManifest, readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { auditHeldoutOverlap, OverlapKind, refusedOverlaps } from "#tools/eval-harness/heldout/dataset/overlap"
import { heldoutRowID } from "#tools/eval-harness/heldout/per/country"

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
		"training-configs": {
			type: "string",
			description: "Training configs of compared models whose cards record no corpus, comma-separated",
		},
		"candidate-model-card": {
			type: "string",
			description: "Which of --model-cards or --training-configs is the candidate's, for the unseen_by_candidate class",
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
		"match-text": {
			type: "boolean",
			description: "Also compare training rows by folded text, reading the dataset's rows file",
		},
		"match-address": {
			type: "boolean",
			description: "Also compare a keyed source's training rows by address key, reading the dataset's rows file",
		},
		"preview-evaluation-groups": {
			type: "string",
			description:
				"An evaluation-group list: leave out every training row whose group or address key it holds, " +
				"as a re-split under it would",
		},
		"refuse-overlap": {
			type: "string",
			description: "Exit 1 when a row overlaps training by these kinds, comma-separated: identity, group, text",
		},
		out: { type: "string", description: "Where to write the provenance file" },
		"duckdb-memory-gib": {
			type: "string",
			description: "DuckDB memory limit in GiB; defaults to openDuckDB's share of host memory",
		},
		"duckdb-threads": { type: "string", description: "DuckDB worker threads" },
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

const kinds = new Set<string>(Object.values(OverlapKind))
const refuse = split(values["refuse-overlap"])

for (const kind of refuse) {
	if (!kinds.has(kind)) throw new Error(`--refuse-overlap ${kind} isn't one of ${[...kinds].join(", ")}`)
}

const datasetRows =
	values["match-text"] === true || values["match-address"] === true
		? (await readHeldoutDatasetRows(values.dataset)).rows
		: undefined

const rowTexts =
	values["match-text"] === true ? new Map(datasetRows!.map((row) => [heldoutRowID(row), row.raw] as const)) : undefined

const addressRows =
	values["match-address"] === true ? new Map(datasetRows!.map((row) => [heldoutRowID(row), row] as const)) : undefined

const previewEvaluationGroups = values["preview-evaluation-groups"]
	? await readEvaluationGroups(values["preview-evaluation-groups"])
	: undefined

const result = await auditHeldoutOverlap({
	dataset: await readHeldoutDatasetManifest(values.dataset),
	...(rowTexts ? { rowTexts } : {}),
	...(addressRows ? { addressRows } : {}),
	...(previewEvaluationGroups ? { previewEvaluationGroups } : {}),
	corpora: split(values.corpora),
	modelCards: split(values["model-cards"]),
	trainingConfigs: split(values["training-configs"]),
	...(values["candidate-model-card"] ? { candidateModelCard: values["candidate-model-card"] } : {}),
	pathRoot: values["path-root"],
	verifyFileSHA256: values["verify-file-sha256"] === true,
	duckDBLimits: {
		...(values["duckdb-memory-gib"]
			? { memoryLimitBytes: Math.floor(Number(values["duckdb-memory-gib"]) * 2 ** 30) }
			: {}),
		...(values["duckdb-threads"] ? { threads: Number(values["duckdb-threads"]) } : {}),
	},
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
	console.log(
		`${card.source} ${card.path}:${card.corpusVersion ?? "no corpus"} ${card.matched ? "matched" : card.problem}`
	)
}

console.log(
	`verified_unseen ${result.audit.counts.verified_unseen}, unseen_by_candidate ${result.audit.counts.unseen_by_candidate}, ` +
		`known_overlap ${result.audit.counts.known_overlap}, ` +
		`unknown ${result.audit.counts.unknown}`
)

for (const reason of result.audit.reasons) {
	console.log(`  verified_unseen refused: ${reason}`)
}

console.log(
	`overlapping rows by kind: ${Object.entries(result.audit.overlapRows)
		.map(([kind, rows]) => `${kind} ${rows}`)
		.join(", ")}`
)

const refused = refusedOverlaps(result.audit, refuse as OverlapKind[])

if (refused.length) {
	console.log(
		`refused: ${refused.map(({ kind, rows }) => `${rows} row(s) overlap training by ${kind}`).join(", ")} ` +
			`(--refuse-overlap ${refuse.join(",")}); the provenance file is written`
	)

	process.exitCode = 1
}
