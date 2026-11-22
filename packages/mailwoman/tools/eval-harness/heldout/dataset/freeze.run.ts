// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Freezes a held-out sample into a versioned dataset manifest and its rows file.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/freeze.run.ts \
 *     --manifest <corpus MANIFEST.json> --dataset-id <name> --out <dataset manifest .json> \
 *     [--per-country 200] [--seed <integer>] [--path-root /mnt/mw] \
 *     [--exclude-dataset <development manifest>,<read manifest>,...] \
 *     [--training-config <next training config .yaml>] [--dry-run]
 *
 *   The rows file is written beside the manifest as `<name>.rows.jsonl`.
 *
 *   `--training-config` names the config the next candidate trains on.
 *   The sample never draws a group one of its receipts requires in training
 *   (`tools/training/audits/required-groups`), and the manifest and the output
 *   record what it skipped, by country.
 *
 *   `--dry-run` reads the pool's counts and the skip and prints them.
 *   It draws no row and writes no file.
 *
 *   `--reserve-groups-per-country <n>` draws a forward reserve instead of a held-out
 *   sample (`heldout/dataset/reserve`): `n` groups per country and row kind from the
 *   corpus's train rows, recorded under the collection kind `reserve`.
 *   `--per-country` and `--path-root` don't apply to it, and `--dry-run` refuses it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"

import { readHeldoutDatasetManifest, writeHeldoutDataset } from "#tools/eval-harness/heldout/dataset/manifest"
import { sampleReserveRows } from "#tools/eval-harness/heldout/dataset/reserve"
import { sampleHeldoutRows } from "#tools/eval-harness/heldout/per/country"
import { describeRequiredGroupSkip, readRequiredTrainingGroups } from "#tools/training/audits/required-groups"
import { loadTrainingConfig } from "#tools/training/config"

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
		"exclude-dataset": {
			type: "string",
			description:
				"Frozen dataset manifests, comma-separated, whose groups this sample never draws: the development set " +
				"first (recorded as excludes), then every set a grading already read (recorded as excludesRead)",
		},
		"skip-files": {
			type: "string",
			description:
				"Manifest file paths (as the manifest lists them) not to read, comma-separated; recorded in the rule",
		},
		"training-config": {
			type: "string",
			description: "The next training config; the sample never draws a group one of its receipts requires in training",
		},
		"dry-run": {
			type: "boolean",
			description: "Print the pool's counts and the required-group skip, draw no row and write nothing",
		},
		"reserve-groups-per-country": {
			type: "string",
			description: "Draw a forward reserve of this many train-pool groups per country and row kind instead",
		},
	},
})

const duckDBLimits = {
	...(values["duckdb-memory-gib"]
		? { memoryLimitBytes: Math.floor(Number(values["duckdb-memory-gib"]) * 2 ** 30) }
		: {}),
	...(values["duckdb-threads"] ? { threads: Number(values["duckdb-threads"]) } : {}),
}

const dryRun = values["dry-run"] === true
const reserve = values["reserve-groups-per-country"]

if (!values.manifest || (!dryRun && (!values["dataset-id"] || !values.out))) {
	throw new Error("--manifest is required, and --dataset-id and --out unless --dry-run")
}

if (dryRun && reserve) throw new Error("--dry-run reads a held-out pool's counts; a reserve draw has no dry run")

const listedPaths = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((path) => path.trim())
		.filter((path) => path.length > 0)

const seed = values.seed == null ? null : Number(values.seed)

if (seed != null && !Number.isSafeInteger(seed)) throw new Error(`--seed ${values.seed} is not an integer`)

const corpus = await readLocalJSONFile<{ corpus_version?: unknown }>(values.manifest)

const exclusions = await Promise.all(
	listedPaths(values["exclude-dataset"]).map(async (path) => {
		const excluded = await readHeldoutDatasetManifest(path)

		return {
			datasetID: excluded.datasetID,
			version: excluded.version,
			groups: [...new Set(excluded.rows.map((row) => row.group))],
		}
	})
)

const required = values["training-config"]
	? await readRequiredTrainingGroups(await loadTrainingConfig(values["training-config"]), duckDBLimits)
	: null

const sample = reserve
	? await sampleReserveRows({
			manifest: values.manifest,
			groupsPerCountry: Number(reserve),
			seed,
			limits: duckDBLimits,
			exclusions,
			required,
			onProgress: (pass, read, all) => {
				if (read % 100 === 0 || read === all) {
					console.error(`reserve: ${pass} ${read}/${all} files`)
				}
			},
		})
	: await sampleHeldoutRows(
			values.manifest,
			dryRun ? 0 : Number(values["per-country"]),
			values["path-root"],
			seed,
			duckDBLimits,
			exclusions,
			listedPaths(values["skip-files"]),
			required
		)

const skip = sample.rule.requiredTrainingGroups

if (skip) {
	for (const line of describeRequiredGroupSkip(skip)) {
		console.log(line)
	}
} else {
	console.log("required training groups: no --training-config, so no group was skipped")
}

if (dryRun) {
	for (const cell of sample.counts) {
		console.log(`  ${cell.country} ${cell.kind}: ${cell.available} rows available`)
	}
} else {
	const engine = await (async () => {
		using db = await openDuckDB()

		return String((await db.runAndReadAll("SELECT version() AS v")).getRowObjects()[0]!.v)
	})()

	const manifest = await writeHeldoutDataset(values.out!, {
		datasetID: values["dataset-id"]!,
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
		`${manifest.datasetID} version ${manifest.version}${manifest.collectionKind ? ` (${manifest.collectionKind})` : ""}: ` +
			`${manifest.rows.length} rows, ${manifest.sources.length} sources, rows sha256 ${manifest.rowsFile.sha256}`
	)
}
