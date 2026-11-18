// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the evaluation candidates of a newer source snapshot (`heldout/snapshot/candidates.ts`).
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/snapshot/candidates.run.ts \
 *     --source usgov-nppes --input <snapshot file or directory of .csv files> --fetch-record <MANIFEST.json> \
 *     --corpora <corpus MANIFEST.json>,<corpus MANIFEST.json> --datasets <frozen manifest>,<frozen manifest> \
 *     --out <directory> [--street-index <street-index.db>] [--path-root /mnt/mw] \
 *     [--duckdb-memory-gib 6] [--duckdb-threads 4]
 *
 *   A directory input is read one `.csv` file at a time, in name order.
 *   Then freeze the candidates with `heldout/dataset/freeze.run.ts --manifest <out>/<source>.candidates.MANIFEST.json`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isDirectory } from "@mailwoman/core/fs/readers/stat"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { BUILTIN_ADAPTERS } from "@mailwoman/corpus/adapters"
import { createUnitSplitter } from "@mailwoman/corpus/adapters/street/unit"
import { tryReadDefaultRegionNames } from "@mailwoman/corpus/build/region-names"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { writeSnapshotCandidates } from "#tools/eval-harness/heldout/snapshot/candidates"

const { values } = parseArguments({
	options: {
		source: { type: "string", description: "The adapter id whose snapshot is read" },
		input: { type: "string", description: "The snapshot file, or a directory of .csv files read one at a time" },
		"fetch-record": { type: "string", description: "The fetch record written beside the snapshot" },
		"street-index": { type: "string", description: "The street index the adapter's unit splitter reads" },
		corpora: { type: "string", description: "Training corpus manifests, comma-separated" },
		datasets: { type: "string", description: "Frozen collection manifests, comma-separated" },
		out: { type: "string", description: "The directory the candidates are written to" },
		"path-root": { type: "string", default: "/mnt/mw", description: "Local directory for a manifest's /data prefix" },
		"duckdb-memory-gib": { type: "string", default: "6", description: "DuckDB memory limit in GiB" },
		"duckdb-threads": { type: "string", default: "4", description: "DuckDB worker threads" },
	},
})

if (!values.source || !values.input || !values.out || !values.corpora || !values["fetch-record"]) {
	throw new Error("--source, --input, --fetch-record, --corpora and --out are required")
}

const listedPaths = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((path) => path.trim())
		.filter((path) => path.length > 0)

const adapter = BUILTIN_ADAPTERS.find((candidate) => candidate.id === values.source)

if (!adapter) throw new Error(`no built-in adapter ${values.source}`)

const inputs = (await isDirectory(values.input))
	? (await Globerator.from("*.csv", { cwd: values.input, absolute: false }).toArray())
			.toSorted()
			.map((name) => resolvePath(values.input!, name).toString())
	: [values.input]

if (!inputs.length) throw new Error(`${values.input} holds no .csv file`)

const streetIndex = values["street-index"] ?? null

const record = await writeSnapshotCandidates({
	adapter,
	adapterOptions: inputs.map((inputPath) => ({ inputPath, streetIndex })),
	fetchRecord: await readLocalJSONFile<unknown>(values["fetch-record"]),
	corpora: listedPaths(values.corpora),
	datasets: listedPaths(values.datasets),
	outDirectory: values.out,
	pathRoot: values["path-root"],
	units: await createUnitSplitter(),
	regions: await tryReadDefaultRegionNames(),
	limits: {
		memoryLimitBytes: Math.floor(Number(values["duckdb-memory-gib"]) * 2 ** 30),
		threads: Number(values["duckdb-threads"]),
	},
	report: (line) => console.error(line),
})

console.log(["country", "labeled", "identity", "text", "repeat", "kept"].join("\t"))

for (const c of record.countries) {
	console.log([c.country, c.labeled, c.excludedByIdentity, c.excludedByText, c.repeatedText, c.kept].join("\t"))
}

console.log(`align: ${stringifyJSON(record.align)}`)
