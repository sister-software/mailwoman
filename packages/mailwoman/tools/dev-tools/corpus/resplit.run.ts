/**
 * @copyright Sister Software
 * @license AGPL-3.0
 *
 *   Re-split a built corpus under a new split policy (HOLDOUT_AND_EVALUATION section 5):
 *   write a split-attribute file for every parquet the manifest lists, under a new corpus
 *   directory, and assemble the new manifest. The parquet files are shared with the base
 *   corpus. Only attributes and the manifest are new. With `--retention`, every row of a
 *   covered country–shape combination stays in training (section 5.1).
 *
 *   Files are independent, so each is split on a worker thread (`resplit-worker.ts`), `--jobs` at a time, largest
 *   first: the largest file bounds the wall time, and starting it first lets the others run beside it. Each worker's
 *   DuckDB instance gets `--duckdb-threads` threads and an equal share of `--duckdb-memory-gb`.
 *
 *   Usage:
 *     node packages/mailwoman/tools/dev-tools/corpus/resplit.run.ts \
 *       --manifest <base corpus>/MANIFEST.json --retention <SPLIT_RETENTION.json> \
 *       --out <new corpus directory> --corpus-version <version> [--jobs 8]
 *     # --limit-files 2 for a smoke run
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { readSplitRetention } from "@mailwoman/corpus/tools/overlay/split/attribute"
import { resolvePathBuilder } from "path-ts"
import { parallelMapWorkers } from "spliterator"

import type { ResplitItem, ResplitResult, ResplitWorkerData } from "#tools/dev-tools/corpus/resplit-worker"

const RESPLIT_WORKER_URL = new URL(
	import.meta.url.endsWith(".ts") ? "./resplit-worker.ts" : "./resplit-worker.js",
	import.meta.url
)

const GIB = 1024 ** 3

interface ManifestFile {
	path: string
	format: string
	compression: string
	rows: number
	bytes: number
	sha256: string
	first_source_id: string
	last_source_id: string
	source: string
	derivation_hash?: string
	split_attribute?: { path: string; sha256?: string; policy_hash?: string; counts?: Record<string, number> }
}

interface CorpusManifest {
	corpus_version: string
	files: ManifestFile[]
	[key: string]: unknown
}

const { values: args } = parseArguments({
	options: {
		manifest: { type: "string" },
		retention: { type: "string" },
		out: { type: "string" },
		"corpus-version": { type: "string" },
		"limit-files": { type: "string" },
		jobs: { type: "string", default: "8", description: "Files split at once, one worker thread each" },
		"duckdb-threads": { type: "string", default: "1", description: "DuckDB threads per worker" },
		"duckdb-memory-gb": { type: "string", default: "8", description: "DuckDB memory across every worker, in GiB" },
	},
})

function readFlagCount(flag: string, value: string | undefined): number {
	const parsed = Number(value)

	if (!(Number.isInteger(parsed) && parsed > 0)) {
		throw new Error(`--${flag} takes a positive integer; received ${stringifyJSON(value)}`)
	}

	return parsed
}

const jobs = readFlagCount("jobs", args.jobs)
const duckdbThreads = readFlagCount("duckdb-threads", args["duckdb-threads"])
const duckdbMemoryGB = readFlagCount("duckdb-memory-gb", args["duckdb-memory-gb"])

if (!args.manifest) throw new Error("--manifest <MANIFEST.json> is required")

if (!args.out) throw new Error("--out <new corpus directory> is required")

if (!args["corpus-version"]) throw new Error("--corpus-version <version> is required")

const limitFiles = args["limit-files"] ? Number(args["limit-files"]) : undefined

if (limitFiles !== undefined && !(Number.isInteger(limitFiles) && limitFiles > 0)) {
	throw new Error(`--limit-files takes a positive integer; received ${stringifyJSON(args["limit-files"])}`)
}

const retention = args.retention ? await readSplitRetention(args.retention) : undefined

if (retention) {
	console.error(`resplit: retention floor ${retention.floor}, ${retention.protectedShapes.size} covered combinations`)
}

const manifest = await readLocalJSONFile<CorpusManifest>(args.manifest)
const files = limitFiles ? manifest.files.slice(0, limitFiles) : manifest.files
const outDir = resolvePathBuilder(args.out)
const started = Date.now()
const items: ResplitItem[] = []

for (const [index, file] of files.entries()) {
	// A file written by a build that predates derivation hashes (every v0.8.0 file, among others) has none.
	// Its directory is keyed by the parquet's own sha256.
	// Every manifest entry records that hash.
	const attributeKey = file.derivation_hash ?? `sha256-${file.sha256}`
	const attributeDir = resolvePathBuilder(outDir, "attributes", file.source, attributeKey)

	await makeDirectories(attributeDir)

	items.push({ index, input: file.path, outputDir: attributeDir.toString() })
}

items.sort((a, b) => files[b.index]!.rows - files[a.index]!.rows)

const workerData: ResplitWorkerData = {
	retentionPath: args.retention ?? null,
	duckdbThreads,
	duckdbMemoryBytes: Math.floor((duckdbMemoryGB * GIB) / jobs),
}

console.error(
	`resplit: ${files.length} files, ${jobs} workers, ${duckdbThreads} DuckDB thread(s) and ` +
		`${(workerData.duckdbMemoryBytes / GIB).toFixed(2)} GiB each`
)

const written = new Map<number, ResplitResult>()

for await (const result of parallelMapWorkers<ResplitItem, ResplitResult>(items, {
	worker: RESPLIT_WORKER_URL,
	concurrency: jobs,
	batchSize: 1,
	workerData,
})) {
	written.set(result.index, result)

	if (written.size % 25 === 0 || written.size === files.length) {
		console.error(`resplit: ${written.size}/${files.length} files, ${((Date.now() - started) / 1000).toFixed(0)}s`)
	}
}

if (written.size !== files.length) throw new Error(`split ${written.size} of ${files.length} files`)

const outManifest: CorpusManifest = {
	...manifest,
	corpus_version: args["corpus-version"],
	resplit_of: manifest.corpus_version,
	...(retention ? { retention: { floor: retention.floor, protectedShapes: retention.protectedShapes.size } } : {}),
	files: files.map((file, index) => {
		const decision = written.get(index)

		if (!decision) throw new Error(`no split decision written for ${file.path}`)

		return {
			...file,
			split_attribute: {
				path: decision.attribute,
				policy_hash: decision.policyHash,
				counts: decision.counts,
			},
		}
	}),
}

await writeLocalJSONFile(outManifest, outDir, "MANIFEST.json")

console.log(
	stringifyJSON({
		manifest: resolvePathBuilder(outDir, "MANIFEST.json").toString(),
		files: files.length,
		retention: retention ? { floor: retention.floor, protectedShapes: retention.protectedShapes.size } : null,
		seconds: Math.round((Date.now() - started) / 1000),
	})
)
