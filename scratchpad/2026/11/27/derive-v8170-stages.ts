import { deepStrictEqual } from "node:assert"
// Writes the two stage configs of v8.17.0 from v8.16.0's by editing its lines, so every line the stages keep is
// byte-for-byte the base's, then parses each result and checks the values it set.
//
// Stage 1 trains the gazetteer: every `wof-admin` and `wof-postalcode` train row of corpus v0.8.22 once, in the
// order the corpus stores them (`data.read_order: stored`). `max_steps` is the two sources' train rows, as the
// sampler counts them (`sourceRowCounts`), over 512 rows a step. Stage 2 starts from stage 1's final checkpoint
// (`train.init_from`) and trains every other source at v8.16.0's weights, with `max_steps` set so each keeps
// v8.16.0's absolute draws.
//
// Usage: node --env-file=/home/lab/Projects/mailwoman/.env scratchpad/2026/11/27/derive-v8170-stages.ts
import { readFileSync, writeFileSync } from "node:fs"

import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"
import { parse } from "yaml"

import { loadTrainingConfig } from "../../../../packages/mailwoman/tools/training/config.ts"
import { samplerConfigJSON } from "../../../../packages/mailwoman/tools/training/sampler.ts"

const dir = "packages/corpus/data/training-configs"
const base = `${dir}/v8.16.0-base-c6-wofreps-positions-v0822-s42.yaml`
const text = readFileSync(base, "utf8")
const GAZETTEER = ["wof-admin", "wof-postalcode"]
const BATCH = 512
// WOF writes these codes outside ISO 3166-1 on `wof-admin` and `wof-postalcode` rows. `FileRows` skips a row whose
// country `country_weights` leaves out, so stage 1 admits them at 1.0.
const WOF_EXTRA_COUNTRIES = ["XK", "XS", "UN", "XZ", "XN"]
// Measured by count-v8170-stage1-countries.ts under v8.16.0's `country_weights`: XK 12,592, XS 3,930, UN 967,
// XZ 647 and XN 75 `wof-admin` train rows, and no `wof-postalcode` row.
const NON_ISO_WOF_ADMIN_ROWS = "18,211"
// v8.16.0's run and its realized draws of the two gazetteer sources, from its exposure record.
const V8160_SAMPLES = 126_000 * 128
const V8160_GAZETTEER_DRAWS = 2_815_839 + 1_151_454
const STAGE1_OUTPUT = "/data/output-v8170-stage1-gazetteer-v0822-s42/checkpoints"
const STAGE2_OUTPUT = "/data/output-v8170-stage2-corpus-v0822-s42/checkpoints"

const dataRoot = process.env.MAILWOMAN_DATA_ROOT

if (!dataRoot) {
	throw new Error("MAILWOMAN_DATA_ROOT is unset; pass --env-file")
}

const baseConfig = await loadTrainingConfig(base)
const mtf = await mtfNode()
const corpusDir = baseConfig.data.corpus_dir.replace(/^\/data\//, `${dataRoot}/`)
const counts = new Map(
	mtf.sourceRowCounts(samplerConfigJSON(baseConfig, { corpusDir }), "train").map(({ source, count }) => [source, count])
)
const gazetteerRows = GAZETTEER.map((source) => {
	const count = counts.get(source)

	if (typeof count !== "number") {
		throw new Error(`sourceRowCounts holds no train count for ${source}`)
	}

	return count
})
// The operator's decision of 2026-11-27: `wof-postalcode` is out of v8.17.0, so `wof-admin` is stage 1's one source.
const STAGE1_SOURCE = "wof-admin"
const stage1Rows = gazetteerRows[0]!
const stage1Steps = Math.ceil(stage1Rows / BATCH)
const stage2Rows = V8160_SAMPLES - V8160_GAZETTEER_DRAWS
const stage2Steps = Math.ceil(stage2Rows / BATCH)
const fmt = (n: number) => n.toLocaleString("en-US")

const KEY = /^ {2}([a-z_]+):/
const COMMENT2 = /^ {2}#/

/**
 * The line range of the `section.key` block: the key's own indent-2 comment lines above it through the line before
 * the next indent-2 line.
 */
function blockRange(lines: string[], section: string, key: string): [number, number] {
	const sectionAt = lines.indexOf(`${section}:`)

	if (sectionAt < 0) {
		throw new Error(`no ${section} section`)
	}

	let at = -1

	for (let i = sectionAt + 1; i < lines.length && !/^[a-z]/.test(lines[i]!); i++) {
		if (lines[i]!.startsWith(`  ${key}:`)) {
			at = i
			break
		}
	}

	if (at < 0) {
		throw new Error(`no ${section}.${key}`)
	}

	let start = at

	while (start - 1 > sectionAt && COMMENT2.test(lines[start - 1]!)) {
		start--
	}

	let end = at + 1

	while (end < lines.length && !KEY.test(lines[end]!) && !COMMENT2.test(lines[end]!) && !/^\S/.test(lines[end]!)) {
		end++
	}

	return [start, end]
}

function deleteBlock(lines: string[], section: string, key: string) {
	const [start, end] = blockRange(lines, section, key)
	lines.splice(start, end - start)
}

function replaceBlock(lines: string[], section: string, key: string, replacement: string[]) {
	const [start, end] = blockRange(lines, section, key)
	lines.splice(start, end - start, ...replacement)
}

function setScalar(lines: string[], section: string, key: string, value: string) {
	const [start, end] = blockRange(lines, section, key)
	const at = lines.findIndex((line, i) => i >= start && i < end && line.startsWith(`  ${key}:`))
	lines[at] = `  ${key}: ${value}`
}

function insertAfter(lines: string[], section: string, key: string, added: string[]) {
	const [, end] = blockRange(lines, section, key)
	lines.splice(end, 0, ...added)
}

/** Removes the `    name: value` lines of `names` from a map block. */
function dropEntries(lines: string[], section: string, key: string, names: string[]) {
	const [start, end] = blockRange(lines, section, key)

	for (let i = end - 1; i > start; i--) {
		if (names.some((name) => lines[i]!.startsWith(`    ${name}:`))) {
			lines.splice(i, 1)
		}
	}
}

/** Removes the `    - name: …` items of a list block whose `source:` is one of `sources`. */
function dropReceipts(lines: string[], section: string, key: string, sources: string[]) {
	const [start, end] = blockRange(lines, section, key)
	let removed = 0

	for (let i = end - 1; i > start; i--) {
		if (!lines[i]!.startsWith("    - ")) {
			continue
		}

		let j = i + 1

		while (j < end - removed && lines[j]!.startsWith("      ")) {
			j++
		}

		if (lines.slice(i, j).some((line) => sources.some((s) => line === `      source: ${s}`))) {
			lines.splice(i, j - i)
			removed += j - i
		}
	}
}

function scaleTrain(lines: string[]) {
	setScalar(lines, "train", "batch_size", String(BATCH))
	setScalar(lines, "train", "learning_rate", "1.0e-3")
	setScalar(lines, "train", "warmup_steps", "250")
	setScalar(lines, "train", "eval_every_steps", "500")
	setScalar(lines, "train", "save_every_steps", "1250")
	setScalar(lines, "train", "log_every_steps", "25")
	setScalar(lines, "train", "fisher_capture_last_n_steps", "500")
	insertAfter(lines, "train", "fisher_capture_last_n_steps", ["  cuda_graph: false"])
}

const CUDA_GRAPH_NOTE = [
	"# `train.cuda_graph` is false: its first capture failed on the A100 (2026-11-27, run 8758701bc86349c1) because",
	"# `cross_entropy_loss` with label smoothing calls `masked_select`, whose `nonzero` syncs with the host (#3531).",
]

const batchNote = [
	"# Both stages train at batch 512 (#3531). `learning_rate` is v8.16.0's 5.0e-4 times the square root of the batch",
	"# ratio, 1.0e-3, and the step-counted keys keep v8.16.0's row counts: `warmup_steps` 1000 → 250, `eval_every_steps`",
	"# 2000 → 500, `save_every_steps` 5000 → 1250, `log_every_steps` 100 → 25 and `fisher_capture_last_n_steps`",
	"# 2000 → 500. `eval_batch_size` stays 128.",
]

function header(stage: string, body: string[]): string[] {
	return [
		`# v8.17.0-${stage}-v0822-s42 is one of the two stages of v8.17.0 (#3531), derived on 2026-11-27 from`,
		"# v8.16.0-base-c6-wofreps-positions-v0822-s42.yaml by scratchpad/2026/11/27/derive-v8170-stages.ts.",
		"#",
		...body,
		"#",
		...batchNote,
		"#",
		"# The notes that follow are v8.16.0's.",
		"#",
	]
}

// Stage 1.
const stage1 = text.split("\n")
const otherSources = [
	...new Set([...Object.keys(baseConfig.data.source_weights ?? {}), ...Object.keys(baseConfig.data.source_reps ?? {})]),
]
	.filter((source) => source !== STAGE1_SOURCE)
	.toSorted((a, b) => (a === "wof-postalcode" ? -1 : b === "wof-postalcode" ? 1 : a.localeCompare(b)))

replaceBlock(stage1, "data", "source_weights", [
	"  # Stage 1 reads only `wof-admin`. The sampler refuses a train source that `source_weights` leaves out, so every",
	"  # other source is listed at 0.0.",
	"  source_weights:",
	`    ${STAGE1_SOURCE}: 1.0`,
	...otherSources.map((source) => `    ${source}: 0.0`),
])

const STAGE1_DROPPED = [
	"source_emit_factors",
	"source_reps",
	"prominent_place_coverage",
	"required_corpus_receipts",
	"required_validation_coverage",
]

for (const key of STAGE1_DROPPED) {
	deleteBlock(stage1, "data", key)
}

const [, countriesEnd] = blockRange(stage1, "data", "country_weights")
const closing = stage1.lastIndexOf("    }", countriesEnd)
stage1.splice(closing, 0, `      ${WOF_EXTRA_COUNTRIES.map((cc) => `${cc}: 1.0`).join(", ")},`)
setScalar(stage1, "data", "train_rows_per_epoch", "null")
insertAfter(stage1, "data", "train_rows_per_epoch", [
	"  # Stage 1 reads the train files in their stored order, each row once (#3531).",
	"  read_order: stored",
])
scaleTrain(stage1)
setScalar(stage1, "train", "output_dir", STAGE1_OUTPUT)
setScalar(stage1, "train", "max_steps", String(stage1Steps))
setScalar(stage1, "train", "fisher_capture", "false")
setScalar(stage1, "train", "trackio_run_name", "v8170-stage1-gazetteer-v0822-s42")

const stage1Text = [
	...header("stage1-gazetteer", [
		"# Stage 1 trains every `wof-admin` train row of corpus v0.8.22 once, reading the corpus's existing train files in",
		"# their stored order (`data.read_order: stored`), with no source draw, shuffle or seed. `wof-postalcode` is out of",
		"# v8.17.0 by the operator's decision of 2026-11-27, so it weighs 0.0 here and in stage 2. Every other source weighs",
		"# 0.0 and `train_rows_per_epoch` is null. `country_weights` adds XK, XS, UN, XZ and XN at 1.0: WOF writes these",
		`# codes outside ISO 3166-1 on ${NON_ISO_WOF_ADMIN_ROWS} \`wof-admin\` train rows, and the sampler skips a row ` +
			"whose country",
		"# `country_weights` leaves out. With them every one of the " +
			`${fmt(stage1Rows)} \`wof-admin\` train rows (\`sourceRowCounts\`)`,
		`# is admitted, so \`max_steps\` is ceil(${fmt(stage1Rows)} / 512) = ${fmt(stage1Steps)}.`,
		"# `source_reps`, `source_emit_factors`, `required_corpus_receipts` and `prominent_place_coverage` are left out,",
		"# because they describe the stage-2 mixture. `required_validation_coverage` is left out because its audit reads",
		"# the admitted countries through `weightedCountries`, which refuses the five codes above. Stage 2 keeps it, and",
		"# stage 2 is the model that's graded. `fisher_capture` is false for the same reason.",
		...CUDA_GRAPH_NOTE,
	]),
	...stage1,
].join("\n")

// Stage 2.
const stage2 = text.split("\n")

insertAfter(
	stage2,
	"data",
	"source_weights",
	GAZETTEER.map((source) => `    ${source}: 0.0`)
)
dropEntries(stage2, "data", "source_emit_factors", GAZETTEER)
dropEntries(stage2, "data", "source_reps", GAZETTEER)
dropReceipts(stage2, "data", "required_corpus_receipts", GAZETTEER)
// The prominent-place receipt counts a form covered only by a train row of a positively weighted source, and stage 2
// weighs `wof-admin` at 0.0, so the receipt fails on forms that stage 1 trains.
deleteBlock(stage2, "data", "prominent_place_coverage")
scaleTrain(stage2)
setScalar(stage2, "train", "output_dir", STAGE2_OUTPUT)
setScalar(stage2, "train", "max_steps", String(stage2Steps))
setScalar(stage2, "train", "trackio_run_name", "v8170-stage2-corpus-v0822-s42")

const finalStep = `step-${String(stage1Steps).padStart(6, "0")}`
insertAfter(stage2, "train", "output_dir", [
	"  # Stage 1's final checkpoint.",
	`  init_from: ${STAGE1_OUTPUT}/${finalStep}`,
])

const stage2Text = [
	...header("stage2-corpus", [
		`# Stage 2 starts from stage 1's final checkpoint, ${finalStep} (\`train.init_from\`), and trains every other source`,
		"# at v8.16.0's weights. `wof-admin` and `wof-postalcode` weigh 0.0 and leave `source_reps`, `source_emit_factors`",
		"# and `required_corpus_receipts` (`wof-admin-exposure`). `wof-postalcode` is out of v8.17.0 by the operator's",
		"# decision of 2026-11-27, so `wof-admin` is stage 1's one source. `max_steps` keeps each other source's v8.16.0",
		`# draws: ceil((${fmt(V8160_SAMPLES)} − 2,815,839 \`wof-admin\` − 1,151,454 \`wof-postalcode\`) / 512) = ` +
			`ceil(${fmt(stage2Rows)} / 512)`,
		`# = ${fmt(stage2Steps)}.`,
		...CUDA_GRAPH_NOTE,
		"# `prominent_place_coverage` is left out: its receipt counts a form covered only by a train row of a positively",
		"# weighted source, and with `wof-admin` at 0.0 the launch preflight found 19,119 of 20,910 required forms present",
		"# and 27 of 811 demand cells failing (AI, AQ, AW, AX, BH, BM, BQ, FO, GU, MP, MV, SH, TC, TV among them), forms",
		"# that stage 1's `wof-admin` pass trains. `rendered-prominent-places` keeps its `source_reps` and its receipt.",
	]),
	...stage2,
].join("\n")

// Check what each edit set.
const s1 = parse(stage1Text) as Record<string, Record<string, unknown>>
const s2 = parse(stage2Text) as Record<string, Record<string, unknown>>
const b = parse(text) as Record<string, Record<string, unknown>>
const positive = (weights: unknown) =>
	Object.entries(weights as Record<string, number>)
		.filter(([, w]) => w > 0)
		.map(([s]) => s)
		.toSorted()

deepStrictEqual(positive(s1.data!.source_weights), [STAGE1_SOURCE])
deepStrictEqual((s1.data!.source_weights as Record<string, number>)["wof-postalcode"], 0)
deepStrictEqual(Object.keys(s1.data!.source_weights as object)[0], STAGE1_SOURCE)

for (const stage of [s1, s2]) {
	deepStrictEqual(stage.train!.cuda_graph, false)
}
deepStrictEqual(s1.data!.read_order, "stored")
deepStrictEqual(s1.data!.train_rows_per_epoch, null)

for (const key of STAGE1_DROPPED) {
	deepStrictEqual(key in s1.data!, false, key)
}

for (const cc of WOF_EXTRA_COUNTRIES) {
	deepStrictEqual((s1.data!.country_weights as Record<string, number>)[cc], 1.0)
}

deepStrictEqual(
	Object.keys(s1.data!.country_weights as object).length,
	Object.keys(b.data!.country_weights as object).length + 5
)

for (const stage of [s1, s2]) {
	deepStrictEqual(
		[
			stage.train!.batch_size,
			stage.train!.learning_rate,
			stage.train!.warmup_steps,
			stage.train!.eval_every_steps,
			stage.train!.save_every_steps,
			stage.train!.log_every_steps,
			stage.train!.fisher_capture_last_n_steps,
			stage.train!.eval_batch_size,
		],
		[512, 1.0e-3, 250, 500, 1250, 25, 500, 128]
	)
}

deepStrictEqual(s1.train!.max_steps, stage1Steps)
deepStrictEqual(s1.train!.fisher_capture, false)
deepStrictEqual(s2.train!.max_steps, stage2Steps)
deepStrictEqual(s2.train!.init_from, `${STAGE1_OUTPUT}/${finalStep}`)
deepStrictEqual(s2.train!.fisher_capture, true)

const w2 = s2.data!.source_weights as Record<string, number>
const bw = b.data!.source_weights as Record<string, number>
deepStrictEqual(w2, { ...bw, "wof-admin": 0, "wof-postalcode": 0 })

for (const key of ["source_reps", "source_emit_factors"]) {
	const expected = { ...(b.data![key] as Record<string, number>) }

	for (const source of GAZETTEER) {
		delete expected[source]
	}

	deepStrictEqual(s2.data![key], expected, key)
}

const receipts = (r: unknown) => (r as { name: string; source: string }[]).map((x) => x.name)
deepStrictEqual(
	receipts(s2.data!.required_corpus_receipts),
	receipts(b.data!.required_corpus_receipts).filter((name) => name !== "wof-admin-exposure")
)

deepStrictEqual("prominent_place_coverage" in s2.data!, false)

// Stage 1 launched from the committed file, so the deriver refuses to change it.
const stage1Path = `${dir}/v8.17.0-stage1-gazetteer-v0822-s42.yaml`

if (readFileSync(stage1Path, "utf8") !== stage1Text) {
	throw new Error(`${stage1Path} would change; stage 1 launched from it`)
}
writeFileSync(`${dir}/v8.17.0-stage2-corpus-v0822-s42.yaml`, stage2Text)
console.log(
	`derive-v8170-stages: wof-admin ${gazetteerRows[0]} (stage 1), wof-postalcode ${gazetteerRows[1]} (out), ` +
		`stage 1 ${stage1Rows} rows ${stage1Steps} steps, stage 2 ${stage2Rows} rows ${stage2Steps} steps`
)
