/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Count how often each tokenizer piece occurs over a corpus's train split, the input `prune.run.ts` reads.
 *
 *   The manifest's train paths are listed as built, so a path under the training volume (`/data/...`) is rewritten
 *   onto this host by `--data-root-remap <from>:<to>`, which defaults to `/data` onto the data root. Every file must
 *   exist after the rewrite. The tool writes `{counts, ...}` to `--out`, with the run's sidecar fields beside the
 *   counts.
 *
 *   Usage: `node packages/mtf/tools/tokenizer/utilization.run.ts --manifest <MANIFEST.json> --tokenizer <model>
 *   --out <json> [--workers <n>] [--data-root-remap <from>:<to>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isFile } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { availableParallelism } from "@mailwoman/core/utils/system"
import { resolvePath } from "path-ts"

import { runMTFTokenizer } from "./binary.ts"

const { values } = parseArguments({
	options: {
		manifest: { type: "string" },
		tokenizer: { type: "string" },
		out: { type: "string" },
		workers: { type: "string", default: String(Math.max(2, availableParallelism() - 2)) },
		"data-root-remap": { type: "string" },
	},
})

const manifestPath = resolvePath(requiredArgument("utilization", "manifest", values.manifest))
const tokenizer = resolvePath(requiredArgument("utilization", "tokenizer", values.tokenizer))
const out = resolvePath(requiredArgument("utilization", "out", values.out))
const remap = values["data-root-remap"] ?? `/data:${dataRootPath()}`
const at = remap.indexOf(":")
const [from, to] = [remap.slice(0, at), remap.slice(at + 1)]
const listed = await runMTFTokenizer<string[]>(["manifest-train-files", "--manifest", manifestPath])
const files = listed.map((path) => (path.startsWith(from) ? to + path.slice(from.length) : path))
const missing: string[] = []

for (const file of files)
	if (!(await isFile(file))) {
		missing.push(file)
	}

if (missing.length) throw new Error(`${missing.length} parquet paths missing locally, first: ${missing[0]}`)

const manifest = await readLocalJSONFile<{ corpus_version?: string; total_rows?: number }>(manifestPath)

console.info(`[utilization] ${files.length} train files, ${manifest.total_rows ?? "?"} rows, workers ${values.workers}`)

const started = performance.now()

await using scratch = await temporaryDirectory("mtf-utilization-")
const filesPath = scratch.path("files.json").toString()
const countsPath = scratch.path("counts.json").toString()

await writeLocalJSONFile(files, filesPath)

const { vocab_size: vocabSize, fired } = await runMTFTokenizer<{ vocab_size: number; fired: number }>([
	"count-pieces",
	"--model",
	tokenizer,
	"--files",
	filesPath,
	"--threads",
	values.workers,
	"--out",
	countsPath,
])

const { counts } = await readLocalJSONFile<{ counts: number[] }>(countsPath)

await writeLocalJSONFile(
	{
		manifest: manifestPath,
		corpus_version: manifest.corpus_version ?? null,
		tokenizer,
		vocab_size: vocabSize,
		train_files: files.length,
		total_rows: manifest.total_rows ?? null,
		fired,
		elapsed_s: Math.round((performance.now() - started) / 100) / 10,
		counts,
	},
	out
)

console.info(`[utilization] wrote ${out}; fired ${fired}/${vocabSize} (${((100 * fired) / vocabSize).toFixed(2)}%)`)
