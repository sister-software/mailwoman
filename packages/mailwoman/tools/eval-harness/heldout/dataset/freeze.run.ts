/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Freezes a held-out sample into a versioned dataset manifest and its rows file.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/freeze.run.ts \
 *     --manifest <corpus MANIFEST.json> --dataset-id <name> --out <dataset manifest .json> \
 *     [--per-country 200] [--seed <integer>] [--path-root /mnt/mw]
 *
 *   The rows file is written beside the manifest as `<name>.rows.jsonl`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"

import { writeHeldoutDataset } from "#tools/eval-harness/heldout/dataset/manifest"
import { sampleHeldoutRows } from "#tools/eval-harness/heldout/per/country"

const { values } = parseArguments({
	options: {
		manifest: {
			type: "string",
			description: "The corpus MANIFEST.json whose test files hold the rows",
		},
		"dataset-id": {
			type: "string",
			description: "The evaluation collection's name",
		},
		"per-country": {
			type: "string",
			default: "200",
			description: "Rows sampled per country and row kind",
		},
		seed: {
			type: "string",
			description: "An integer mixed into the sampling order hash",
		},
		"path-root": {
			type: "string",
			default: "/mnt/mw",
			description: "Local directory for the manifest's /data prefix",
		},
		out: { type: "string", description: "Where to write the dataset manifest" },
		"duckdb-memory-gib": {
			type: "string",
			description: "DuckDB memory limit in GiB; defaults to openDuckDB's share of host memory",
		},
		"duckdb-threads": { type: "string", description: "DuckDB worker threads" },
	},
})

const duckDBLimits = {
	...(values["duckdb-memory-gib"]
		? { memoryLimitBytes: Math.floor(Number(values["duckdb-memory-gib"]) * 2 ** 30) }
		: {}),
	...(values["duckdb-threads"] ? { threads: Number(values["duckdb-threads"]) } : {}),
}

if (!values.manifest || !values["dataset-id"] || !values.out) {
	throw new Error("--manifest, --dataset-id and --out are required")
}

const seed = values.seed == null ? null : Number(values.seed)

if (seed != null && !Number.isSafeInteger(seed)) throw new Error(`--seed ${values.seed} is not an integer`)

const corpus = await readLocalJSONFile<{ corpus_version?: unknown }>(values.manifest)

const sample = await sampleHeldoutRows(
	values.manifest,
	Number(values["per-country"]),
	values["path-root"],
	seed,
	duckDBLimits
)

const engine = await (async () => {
	using db = await openDuckDB()

	return String((await db.runAndReadAll("SELECT version() AS v")).getRowObjects()[0]!.v)
})()

const manifest = await writeHeldoutDataset(values.out, {
	datasetID: values["dataset-id"],
	createdAt: new Date().toISOString(),
	drawnFrom: {
		manifest: values.manifest,
		sha256: await sha256File(values.manifest),
		corpusVersion: typeof corpus.corpus_version === "string" ? corpus.corpus_version : null,
		files: sample.files,
	},
	sampling: { ...sample.rule, engine: `duckdb ${engine}` },
	cells: sample.counts,
	rows: sample.rows,
})

console.log(
	`${manifest.datasetID} version ${manifest.version}: ${manifest.rows.length} rows, ${manifest.sources.length} sources, ` +
		`rows sha256 ${manifest.rowsFile.sha256}`
)
