// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Reports how a run's consumed rows cover the retention table's retained country–shape keys.
 *   Before launch, `--config` replays the configured mixture's first `--draws` rows at the trainer's seed
 *   (`train.seed + 1`), the rows a run would consume over those draws. During a run, `--counts` reads the
 *   `exposure-shapes-<step>.json` the Rust trainer writes at each checkpoint.
 *
 *   `--intended` also derives the draws the config's weights intend per key, from one pass over the train split, and
 *   compares every key's consumed count with them. With `--counts` it still needs `--config` for the weights. The
 *   intention is at the draw level, while a trainer's counts include the augmented copies the emit step adds, so a key
 *   an augmentation writes reads as unintended and the drawn keys share the consumed rows with those copies.
 *
 *   The tool exits 1 when a retained key was never drawn, or under `--intended` when a retained key's consumed count
 *   has a Poisson lower-tail bound under `UNDER_EXPOSURE_LEVEL` at its intended draws, so a launch or a run stops for
 *   investigation.
 *   Usage:
 *     node packages/mailwoman/tools/training/exposure/shapes.run.ts --retention <SPLIT_RETENTION.json> \
 *       [--config <config>.yaml [--draws <n>] [--corpus-dir <dir>]] \
 *       [--counts <output_dir>/exposure-shapes-<step>.json] [--intended] --json <report.json>
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import { mtfNode, type MTFNode } from "@mailwoman/mtf/tools/sampler/native"

import { drawnRows } from "../audits/census.ts"
import { requestedShares, resolveSourceWeights } from "../audits/epoch/mixture.ts"
import { loadTrainingConfig } from "../config.ts"
import { samplerConfigJSON } from "../sampler.ts"
import {
	countShapes,
	countSourceShapes,
	intendedShapeDraws,
	intendedShapeExposure,
	shapeExposure,
	UNDER_EXPOSURE_LEVEL,
	type IntendedExposureReport,
} from "./shapes.ts"

const { values } = parseArguments({
	options: {
		retention: { type: "string" },
		config: { type: "string" },
		"corpus-dir": { type: "string" },
		draws: { type: "string" },
		counts: { type: "string" },
		intended: { type: "boolean", default: false },
		json: { type: "string" },
	},
})

if (!values.retention || !values.json || !(values.config || values.counts)) {
	throw new Error("shapes: pass --retention, --json and --config, --counts or both")
}

if (values.intended && !values.config) throw new Error("shapes: --intended reads the weights from --config")

const retention = await readLocalJSONFile<{ protectedShapes: string[] }>(values.retention)
const loaded = values.config ? await loadTrainingConfig(values.config) : null

const config: TrainingConfig | null = loaded && {
	...loaded,
	data: { ...loaded.data, corpus_dir: values["corpus-dir"] ?? loaded.data.corpus_dir },
}

const mtf = config ? await mtfNode() : null
let counts: Map<string, number>
let consumedRows: number
const input: Record<string, string> = {}

if (values.counts) {
	const file = await readLocalJSONFile<{ shapes: Record<string, number>; row_count: number; counted_to_step: number }>(
		values.counts
	)

	counts = new Map(Object.entries(file.shapes))
	consumedRows = file.row_count
	Object.assign(input, { counts: values.counts, counted_to_step: String(file.counted_to_step) })
} else {
	const draws = (values.draws ? Number(values.draws) : 0) || config!.data.train_rows_per_epoch

	if (!draws) throw new Error("shapes: the config states no train_rows_per_epoch; pass --draws")
	const counted = countShapes(drawnRows(mtf!, config!, { seed: config!.train.seed + 1, draws }))

	counts = counted.counts
	consumedRows = counted.rows
	Object.assign(input, { draws: String(draws), seed: String(config!.train.seed + 1) })
}

if (config) {
	Object.assign(input, { config: values.config!, corpus_dir: config.data.corpus_dir })
}

/**
 * Every train row of an admitted country, over the columns a shape key reads.
 */
function* trainShapeRows(addon: MTFNode, training: TrainingConfig) {
	const admitted = Object.entries(training.data.country_weights)
		.filter(([, weight]) => weight > 0)
		.map(([country]) => country)

	const reader = new addon.SplitColumns(samplerConfigJSON(training), "train", ["source", "country", "span_tags"], {
		column: "country",
		values: admitted,
	})

	for (let chunk = reader.nextChunk(); chunk; chunk = reader.nextChunk()) {
		const source = chunk.strings["source"] ?? []
		const country = chunk.strings["country"] ?? []
		const tags = chunk.lists["span_tags"] ?? []

		for (let i = 0; i < chunk.rows; i++) {
			yield { source: source[i] ?? null, country: country[i] ?? null, spanTags: tags[i] ?? null }
		}
	}
}

let intended: IntendedExposureReport | null = null

if (values.intended) {
	const { weights } = resolveSourceWeights(mtf!, config!, config!.data.corpus_dir)
	const sources = countSourceShapes(trainShapeRows(mtf!, config!), config!.data.country_weights)
	const draws = intendedShapeDraws(requestedShares(weights), consumedRows, sources)

	intended = intendedShapeExposure(draws, counts, consumedRows, retention.protectedShapes)
}

const report = shapeExposure(retention.protectedShapes, counts, consumedRows)

await writeLocalJSONFile(
	{
		schema: "mailwoman.shape-exposure/v2",
		retention: values.retention,
		input,
		...report,
		intended: intended && { underExposureLevel: UNDER_EXPOSURE_LEVEL, ...intended },
	},
	values.json
)

console.log(
	`retained keys ${report.retainedKeys}, drawn ${report.drawn}, never drawn ${report.undrawn.length}, ` +
		`consumed rows ${report.consumedRows}`
)

for (const key of report.undrawn.slice(0, 20)) {
	console.log(`  never drawn: ${key}`)
}

const retainedUnder = intended
	? intended.byKey.filter((row) => row.retained && row.lowerTailBound < UNDER_EXPOSURE_LEVEL)
	: []

if (intended) {
	console.log(
		`intended: ${intended.keys} keys, ${intended.underExposed.length} under-exposed (${retainedUnder.length} retained), ` +
			`${intended.retainedBelowOneIntended.length} retained keys intended under one draw, ` +
			`${intended.unintended.length} consumed keys intended none`
	)

	for (const row of retainedUnder.slice(0, 20)) {
		console.log(`  under-exposed: ${row.key} consumed ${row.consumed} of ${row.intended.toFixed(1)} intended`)
	}
}

if (report.undrawn.length || retainedUnder.length) {
	process.exitCode = 1
}
