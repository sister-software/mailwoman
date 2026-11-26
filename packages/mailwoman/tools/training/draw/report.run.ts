// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Prints a config's expected draws per source and, with `--previous`, every source whose
 *   draws fell by more than `--bound` (default 0.05) from the previous config's run.
 *   Exits 1 when such a fall exists.
 *
 *   Each config is read against its own corpus on the host (`rerootToHost`).
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/draw/report.run.ts --config <yaml> [--previous <yaml>] [--bound 0.05] \
 *       [--tsv <path>]
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { loadTrainingConfig, rerootToHost } from "../config.ts"
import { drawFalls, expectedDraws } from "./report.ts"

const { values } = parseArguments({
	options: {
		config: { type: "string" },
		previous: { type: "string" },
		bound: { type: "string", default: "0.05" },
		tsv: { type: "string" },
	},
})

if (!values.config) throw new Error("--config is required")

const mtf = await mtfNode()

const drawsOf = async (path: string) => {
	const config = rerootToHost(await loadTrainingConfig(path))

	return { config, draws: expectedDraws(mtf, config, config.data.corpus_dir) }
}

const current = await drawsOf(values.config)
const samples = current.draws.reduce((sum, { draws }) => sum + draws, 0)
const lines = ["source\ttrain_rows\texpected_draws\tdraws_per_row\tshare"]

for (const { source, rows, draws } of current.draws.toSorted((a, b) => b.draws - a.draws)) {
	lines.push(
		`${source}\t${rows}\t${Math.round(draws)}\t${rows ? (draws / rows).toFixed(4) : ""}\t${(draws / samples).toFixed(4)}`
	)
}

if (values.tsv) {
	await writeLocalTextFile(`${lines.join("\n")}\n`, values.tsv)
}

console.log(`${values.config}: ${Math.round(samples)} draws over ${current.draws.length} sources`)
console.log(lines.slice(0, 16).join("\n"))

if (values.previous) {
	const previous = await drawsOf(values.previous)
	const bound = Number(values.bound)
	const falls = drawFalls(previous.draws, current.draws, bound)

	console.log(`\nAgainst ${values.previous}: ${falls.length} sources fell by more than ${bound}`)

	for (const { source, previous: before, current: after, fall } of falls) {
		console.log(`  ${source}\t${Math.round(before)} → ${Math.round(after)}\t−${(100 * fall).toFixed(1)}%`)
	}

	if (falls.length) {
		process.exitCode = 1
	}
}
