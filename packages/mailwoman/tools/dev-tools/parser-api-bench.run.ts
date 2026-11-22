// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Times the two ways to parse with `mailwoman` over the regression cases and compares their trees.
 *
 * The arms are a single-model `createRuntimePipeline` and a `createParser` parser.
 * Each arm reports its cold start (loading and the first call), its warm
 * per-call latency, the per-call time outside the pipeline's own stage timings,
 * and its throughput sequentially and in concurrent chunks.
 *
 * The tool then lists every row whose tree differs between the single-model arm
 * and the parser arm, with the row's script family.
 */

import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core/pipeline"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { percentile } from "@mailwoman/core/stats"
import { NeuralAddressClassifier, scriptFamilyForText } from "@mailwoman/neural"

import { createParser } from "#parser"
import { createRuntimePipeline } from "#runtime-pipeline"
import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"

const { values } = parseArguments({
	options: {
		/**
		 * The number of regression cases to parse, taken in the corpus order.
		 */
		limit: { type: "string", default: "500" },
		/**
		 * The number of calls each concurrent chunk starts together.
		 */
		concurrency: { type: "string", default: "8" },
		/**
		 * The number of timed passes over the rows, after the warm-up.
		 */
		passes: { type: "string", default: "3" },
	},
})

type ParseFn = (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult>

const limit = Number(values.limit)
const concurrency = Number(values.concurrency)
const passes = Number(values.passes)
const rows = (await loadRegressionCases()).slice(0, limit)

interface Arm {
	name: string
	coldMs: number
	parse: ParseFn
}

async function coldArm(name: string, build: () => Promise<ParseFn>): Promise<Arm> {
	const startedAt = performance.now()
	const fn = await build()

	await fn(rows[0]!.input)

	return { name, coldMs: performance.now() - startedAt, parse: fn }
}

// The script's process owns both arms' pipelines and scopes, and exits when the report is printed.
const arms = [
	await coldArm("runtime-pipeline", async () =>
		createRuntimePipeline({ classifier: await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" }) })
	),
	await coldArm("createParser", async () => {
		const parser = await createParser()

		return (raw, runOpts) => parser.parse(raw, runOpts)
	}),
]

function stageMilliseconds(result: PipelineResult): number {
	return Object.values(result.timing).reduce((sum, ms) => sum + ms, 0)
}

function summary(samples: number[]) {
	return {
		p50: percentile(samples, 50),
		p90: percentile(samples, 90),
		p99: percentile(samples, 99),
	}
}

const trees = new Map<string, string[]>()
const report = []

for (const arm of arms) {
	for (const row of rows.slice(0, 5)) {
		await arm.parse(row.input)
	}

	const latencies: number[] = []
	const outside: number[] = []
	const tokenClassify: number[] = []
	const armTrees: string[] = []
	const sequentialStartedAt = performance.now()

	for (let pass = 0; pass < passes; pass++) {
		for (const row of rows) {
			const startedAt = performance.now()
			const result = await arm.parse(row.input)
			const wall = performance.now() - startedAt

			latencies.push(wall)
			outside.push(wall - stageMilliseconds(result))
			tokenClassify.push(result.timing["token-classify"] ?? 0)

			if (pass === 0) {
				armTrees.push(stringifyJSON(result.tree))
			}
		}
	}

	const sequentialMs = performance.now() - sequentialStartedAt
	const concurrentStartedAt = performance.now()

	for (let start = 0; start < rows.length; start += concurrency) {
		await Promise.all(rows.slice(start, start + concurrency).map((row) => arm.parse(row.input)))
	}

	const concurrentMs = performance.now() - concurrentStartedAt

	trees.set(arm.name, armTrees)

	report.push({
		arm: arm.name,
		coldMs: Math.round(arm.coldMs),
		latencyMs: summary(latencies),
		outsideStagesMs: summary(outside),
		tokenClassifyMs: summary(tokenClassify),
		sequentialPerSecond: (rows.length * passes) / (sequentialMs / 1000),
		concurrentPerSecond: rows.length / (concurrentMs / 1000),
	})
}

const baseline = trees.get("runtime-pipeline")!

const differences = rows.flatMap((row, index) => {
	const differing = arms
		.slice(1)
		.filter((arm) => trees.get(arm.name)![index] !== baseline[index])
		.map((arm) => arm.name)

	return differing.length
		? [{ id: row.id, input: row.input, script: scriptFamilyForText(row.input), arms: differing }]
		: []
})

process.stdout.write(
	prettyJSON({
		rows: rows.length,
		passes,
		concurrency,
		rss: process.memoryUsage().rss,
		arms: report,
		treesDiffering: differences.length,
		differences,
	})
)
