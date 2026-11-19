// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Compares the tag orders of two corpora, or two recipe outputs, per source and country, before a launch.
 *
 *   Each side is a corpus `MANIFEST.json` or one recipe-output parquet, counted by `countTrainShapes`:
 *   a manifest's train rows, or every row of the parquet. The tool prints each source and country whose
 *   orders differ, with both sides' shares, for the whole span-tag sequence and for its admin tail.
 *
 *   It exits 1 when an order's share moved by more than `--tolerance` in a country that no
 *   `--explain <CC>=<reason>` names, so a re-render that collapses a country to one order stops the launch.
 *   Usage:
 *     node packages/mailwoman/tools/training/exposure/shape-diff.run.ts \
 *       --before <MANIFEST.json | recipe.parquet> --after <MANIFEST.json | recipe.parquet> \
 *       [--source <source>[,<source>…]] [--tolerance 0.05] [--explain IN="…"]… [--memory-gb <n>] [--json <report.json>]
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { compareShapeDistributions, shapeDistribution, ShapeView, type ShapeDifference } from "./shape-diff.ts"
import { countTrainShapes, type TrainShapeCount } from "./train-shapes.ts"

const { values } = parseArguments({
	options: {
		before: { type: "string", description: "A corpus MANIFEST.json or a recipe-output parquet" },
		after: { type: "string", description: "A corpus MANIFEST.json or a recipe-output parquet" },
		source: { type: "string", description: "Compare only these sources, comma-separated" },
		tolerance: { type: "string", default: "0.05", description: "The share an order may move unexplained" },
		explain: { type: "string", multiple: true, description: "<CC>=<reason> for an expected change" },
		"memory-gb": { type: "string", default: "2" },
		json: { type: "string", description: "Where to write the differences" },
	},
})

if (!values.before || !values.after) throw new Error("shape-diff: pass --before and --after")

const tolerance = Number(values.tolerance)

if (!(tolerance >= 0 && tolerance < 1)) throw new Error(`shape-diff: --tolerance ${values.tolerance} isn't in [0, 1)`)

const explanations = new Map<string, string>()

for (const entry of values.explain ?? []) {
	const at = entry.indexOf("=")

	if (at < 2) throw new Error(`shape-diff: --explain ${entry} isn't <CC>=<reason>`)

	explanations.set(entry.slice(0, at).trim().toUpperCase(), entry.slice(at + 1).trim())
}

const sources = values.source ? new Set(values.source.split(",").map((source) => source.trim())) : null
const limits = { memoryLimitBytes: Number(values["memory-gb"]) * 1024 ** 3, threads: 2 }

await using scratch = await temporaryDirectory("shape-diff-")

/**
 * Counts one side: a manifest's train rows, or a parquet's rows.
 *
 * A parquet is counted through a one-file manifest that lists it as train.
 */
async function count(path: string, name: string): Promise<TrainShapeCount[]> {
	let manifest = path

	if (path.endsWith(".parquet")) {
		manifest = scratch.path(`${name}.json`).toString()
		await writeLocalJSONFile({ files: [{ path, split: "train" }] }, manifest)
	}

	const counts = await countTrainShapes(manifest, limits)

	return sources ? counts.filter((row) => row.source != null && sources.has(row.source)) : counts
}

const before = await count(values.before, "before")
const after = await count(values.after, "after")

const percent = (share: number) => `${(100 * share).toFixed(1)}%`
const differences: ShapeDifference[] = []
let unexplained = 0

for (const view of [ShapeView.AdminTail, ShapeView.Sequence]) {
	const found = compareShapeDistributions(
		shapeDistribution(before, view),
		shapeDistribution(after, view),
		view,
		tolerance
	)

	console.log(`\n## ${view}: ${found.length} source–country pair(s) differ`)

	for (const difference of found) {
		const reason = explanations.get(difference.country)
		const status = !difference.moved ? "within tolerance" : reason ? `explained: ${reason}` : "UNEXPLAINED"

		if (difference.moved && !reason) {
			unexplained++
		}

		console.log(
			`\n${difference.source} ${difference.country} (${difference.beforeRows} -> ${difference.afterRows} rows): ${status}`
		)

		for (const order of difference.orders) {
			console.log(
				`  ${order.order}: ${order.before} (${percent(order.beforeShare)}) -> ${order.after} (${percent(order.afterShare)})`
			)
		}
	}

	differences.push(...found)
}

const unused = [...explanations.keys()].filter((country) => !differences.some((d) => d.moved && d.country === country))

for (const country of unused) {
	console.log(`\n--explain ${country} matched no moved order`)
}

if (values.json) {
	await writeLocalJSONFile({ before: values.before, after: values.after, tolerance, differences }, values.json)
}

console.log(`\n${unexplained} unexplained change(s) beyond a share of ${tolerance}`)

if (unexplained) {
	process.exitCode = 1
}
