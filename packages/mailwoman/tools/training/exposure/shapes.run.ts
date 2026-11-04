// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Reports how a run's consumed rows cover the retention table's retained country–shape keys.
 *   Before launch, `--config` replays the configured mixture's first `--draws` rows at the trainer's seed
 *   (`train.seed + 1`), the rows a run would consume over those draws. During a run, `--counts` reads the
 *   `exposure-shapes-<step>.json` the Rust trainer writes at each checkpoint. The tool exits 1 when a retained key
 *   was never drawn, so a launch or a run stops for investigation.
 *   Usage:
 *     node packages/mailwoman/tools/training/exposure/shapes.run.ts --retention <SPLIT_RETENTION.json> \
 *       (--config <config>.yaml [--draws <n>] | --counts <output_dir>/exposure-shapes-<step>.json) --json <report.json>
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { drawnRows } from "../audits/census.ts"
import { loadTrainingConfig } from "../config.ts"
import { countShapes, shapeExposure } from "./shapes.ts"

const { values } = parseArguments({
	options: {
		retention: { type: "string" },
		config: { type: "string" },
		draws: { type: "string" },
		counts: { type: "string" },
		json: { type: "string" },
	},
})

if (!values.retention || !values.json || Boolean(values.config) === Boolean(values.counts)) {
	throw new Error("shapes: pass --retention, --json and exactly one of --config or --counts")
}

const retention = await readLocalJSONFile<{ protectedShapes: string[] }>(values.retention)
let counts: Map<string, number>
let consumedRows: number
let input: Record<string, string>

if (values.config) {
	const config = await loadTrainingConfig(values.config)
	const draws = (values.draws ? Number(values.draws) : 0) || config.data.train_rows_per_epoch

	if (!draws) throw new Error("shapes: the config states no train_rows_per_epoch; pass --draws")
	const mtf = await mtfNode()
	const counted = countShapes(drawnRows(mtf, config, { seed: config.train.seed + 1, draws }))

	counts = counted.counts
	consumedRows = counted.rows
	input = { config: values.config, draws: String(draws), seed: String(config.train.seed + 1) }
} else {
	const file = await readLocalJSONFile<{ shapes: Record<string, number>; row_count: number; counted_to_step: number }>(
		values.counts!
	)

	counts = new Map(Object.entries(file.shapes))
	consumedRows = file.row_count
	input = { counts: values.counts!, counted_to_step: String(file.counted_to_step) }
}

const report = shapeExposure(retention.protectedShapes, counts, consumedRows)

await writeLocalJSONFile(
	{ schema: "mailwoman.shape-exposure/v1", retention: values.retention, input, ...report },
	values.json
)

console.log(
	`retained keys ${report.retainedKeys}, drawn ${report.drawn}, never drawn ${report.undrawn.length}, ` +
		`consumed rows ${report.consumedRows}`
)

for (const key of report.undrawn.slice(0, 20)) {
	console.log(`  never drawn: ${key}`)
}

if (report.undrawn.length) {
	process.exitCode = 1
}
