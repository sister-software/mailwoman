/**
 * How often each parse register fires, across the populations the model is trained and graded on.
 *
 * The name carries `parse-` because `register` means two unrelated things in this directory: `register-board.ts`
 * projects a query into a letter case (`asis`, `lower`, `upper`), while this counts the `fragmented` / `formatted`
 * register that decides which evidence the decoder is fed.
 *
 * The register decides whether the decoder is fed `streetTypeLexicon` and `localitySurfaceLexicon`
 * (`packages/neural/lib/classifier/index.ts`): `fragmented` feeds both, `formatted` withholds both. Training feeds them
 * on every row — `corpus-python/src/mailwoman_train/` carries no dropout for either channel — so the share of input
 * that classifies into `formatted` is the share served without evidence the model always had while learning.
 *
 * That share is the quantity a dropout curriculum would exist to serve, and it has never been counted. Read it before
 * building the knob.
 *
 * The register comes from `deriveGeocodeRegister`, the same function the geocode path calls, so this counts what
 * production does rather than a re-derivation of it.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/parse-register-census.run.ts
 *     node packages/mailwoman/lib/dev-tools/parse-register-census.run.ts --corpus <dir> --corpus-limit 200000
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { dirtyTrackedFiles, gitHead } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { isoSeconds } from "@mailwoman/core/utils"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { computeQueryShape } from "@mailwoman/query-shape/compute"
import { JSONSpliterator } from "spliterator"

import { deriveGeocodeRegister } from "#geocode/core"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		corpus: { type: "string" },
		"corpus-limit": { type: "string", default: "200000" },
	},
})

interface Tally {
	rows: number
	formatted: number
	byKind: Record<string, number>
}

function emptyTally(): Tally {
	return { rows: 0, formatted: 0, byKind: {} }
}

function count(tally: Tally, text: string): void {
	if (!text) return

	const shape = computeQueryShape(text)

	tally.rows++

	if (deriveGeocodeRegister(text, shape) === "formatted") {
		tally.formatted++
	}

	const kind = classifyKindSync({ raw: text, normalized: text }, shape).kind

	tally.byKind[kind] = (tally.byKind[kind] ?? 0) + 1
}

const populations: Record<string, Tally> = {}

/**
 * The golden answer keys, which are the rows every per-tag F1 in the promotion battery is computed over.
 */
for (const locale of ["us", "fr", "adversarial"]) {
	const path = repoRootPath("data", "eval", "golden", "v0.1.3", "dev", `${locale}.jsonl`)

	if (!(await pathExists(path))) continue

	const tally = emptyTally()

	// The golden rows carry the surface as `raw`; the coordinate panels carry it as `input`.
	for await (const row of JSONSpliterator.fromAsync<{ raw?: string; input?: string }>(path)) {
		count(tally, row.raw ?? row.input ?? "")
	}

	populations[`golden/${locale}`] = tally
}

/**
 * The coordinate panels the locality arc is graded on. Their rows are rendered rather than stored, so the bare admin
 * surface this census exists to size is only visible here.
 */
for (const panel of ["us", "us-shape-stratified"]) {
	const path = String(dataRootPath("eval", "coord", `${panel}.jsonl`))

	if (!(await pathExists(path))) continue

	const tally = emptyTally()

	for await (const row of JSONSpliterator.fromAsync<{ input?: string }>(path)) {
		count(tally, row.input ?? "")
	}

	populations[`coord/${panel}`] = tally
}

/**
 * A corpus sample, which is the distribution the model learned the channels under. `raw` is the rendered surface each
 * training row presents to the tokenizer.
 */
if (values.corpus) {
	const { DuckDBInstance } = await import(/* webpackIgnore: true */ "@duckdb/node-api")
	const connection = await (await DuckDBInstance.create(":memory:")).connect()
	const limit = Number(values["corpus-limit"])

	const reader = await connection.runAndReadAll(
		`SELECT raw FROM read_parquet('${values.corpus}/*/train/*.parquet') USING SAMPLE ${limit} ROWS`
	)

	const tally = emptyTally()

	for (const row of reader.getRowObjects()) {
		count(tally, String(row.raw ?? ""))
	}

	populations["corpus sample"] = tally
}

console.log(`\n| population | rows | formatted | fragmented |`)
console.log(`| --- | --: | --: | --: |`)

for (const [name, tally] of Object.entries(populations)) {
	console.log(
		`| ${name} | ${tally.rows} | ${tally.formatted} (${formatPercent(tally.formatted, tally.rows, 1)}) | ` +
			`${tally.rows - tally.formatted} (${formatPercent(tally.rows - tally.formatted, tally.rows, 1)}) |`
	)
}

for (const [name, tally] of Object.entries(populations)) {
	const kinds = Object.entries(tally.byKind).toSorted((left, right) => right[1] - left[1])

	console.log(`\n${name} by kind:`)

	for (const [kind, rows] of kinds) {
		console.log(`  ${kind.padEnd(20)} ${String(rows).padStart(7)}  ${formatPercent(rows, tally.rows, 1)}`)
	}
}

if (values["out-json"]) {
	const repoRoot = repoRootPath()

	await writeLocalJSONFile(
		{
			provenance: {
				ranAt: isoSeconds(),
				gitCommit: await gitHead(repoRoot),
				gitDirtyTrackedFiles: (await dirtyTrackedFiles(repoRoot)).length,
				corpus: values.corpus ?? null,
				corpusLimit: values.corpus ? Number(values["corpus-limit"]) : null,
			},
			populations,
		},
		values["out-json"]
	)

	console.log(`\nwrote ${values["out-json"]}`)
}
