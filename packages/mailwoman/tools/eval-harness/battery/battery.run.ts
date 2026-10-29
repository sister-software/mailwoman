/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Scores a baseline and candidate models on every frozen suite and writes `<out>.json`, every row with each arm's
 *   fields, outcome and cause, and `<out>.md`, the comparison with the failure groups and their full addresses.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/battery/battery.run.ts \
 *     --arm shipped=<weights cache> --arm b42=<cache> --arm b43=<cache> --seeds b42,b43 --out <report prefix> \
 *     [--baseline shipped] [--suites a,b] [--workers 6] [--threads 2]
 *
 *   `--from-report <report .json>` prints the failure groups of a report this command wrote earlier, without scoring.
 *
 *   Each weights cache must hold every Latin locale package (the `full-cache` layout). Parses are cached per arm and
 *   suite under `$MAILWOMAN_DATA_ROOT/models/arms/battery/<arm>/<suite>[-v2].jsonl` and reused when present. For the
 *   `v1` rows the parse files the suites were first scored with (`models/arms/<suite>-parses-<arm>.jsonl`) are
 *   read when no cached file exists. Delete an arm's directory to parse again.
 *
 *   The first `--arm` is the baseline unless `--baseline` names another. `--seeds` names the candidate arms that are
 *   seeds of one recipe. The report then counts the rows on which they disagree, and the failure groups read a fix or
 *   break as every seed agreeing against the baseline.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { JSONSpliterator } from "spliterator"

import {
	type BatteryArm,
	type BatteryReport,
	type BatteryRowResult,
	formatBatteryReport,
	scoreBatteryRow,
} from "#tools/eval-harness/battery/battery"
import type { BatterySpan } from "#tools/eval-harness/battery/classify"
import { formatFailureGroups, groupBatteryFailures } from "#tools/eval-harness/battery/failure-groups"
import { parseBatteryRows } from "#tools/eval-harness/battery/parse-rows"
import {
	BATTERY_SUITE_DIR,
	BATTERY_SUITES,
	type BatterySuiteRow,
	type BatterySuiteSpec,
} from "#tools/eval-harness/battery/suites"

const { values } = parseArguments({
	options: {
		arm: { type: "string", multiple: true, description: "name=<weights cache>, once per arm" },
		baseline: { type: "string", description: "The baseline arm's name (default: the first --arm)" },
		seeds: { type: "string", description: "Candidate arms that are seeds of one recipe, comma-separated" },
		out: { type: "string", description: "Report prefix; writes <out>.json and <out>.md" },
		suites: { type: "string", description: "Suite ids to score, comma-separated (default: every suite)" },
		workers: { type: "string", default: "6", description: "Parse worker threads" },
		threads: { type: "string", default: "2", description: "ONNX threads per parse worker" },
		"from-report": { type: "string", description: "A report this command wrote; print its failure groups" },
	},
})

if (values["from-report"]) {
	const report = await readLocalJSONFile<BatteryReport>(values["from-report"])

	console.log(
		formatFailureGroups(
			groupBatteryFailures(report),
			report.arms.map((arm) => arm.name)
		)
	)
} else {
	await runBattery()
}

/**
 * The parse file for an arm and suite, parsing the suite when no cached file exists.
 */
async function parsesFor(arm: BatteryArm, spec: BatterySuiteSpec): Promise<string> {
	const armDir = dataRootPath("models", "arms", "battery", arm.name)

	const cached = dataRootPath(
		"models",
		"arms",
		"battery",
		arm.name,
		`${spec.id}${spec.rows === "v1" ? "" : `-${spec.rows}`}.jsonl`
	)

	if (await pathExists(cached)) return cached.toString()

	const legacy = dataRootPath("models", "arms", `${spec.id}-parses-${arm.name}.jsonl`)

	if (spec.rows === "v1" && (await pathExists(legacy))) return legacy.toString()

	await makeDirectories(armDir)

	console.error(`parsing ${spec.id} with ${arm.name}`)

	await parseBatteryRows(`${BATTERY_SUITE_DIR}/${spec.id}-${spec.rows}.rows.jsonl`, cached.toString(), {
		cacheRoot: arm.cache,
		workers: Number(values.workers),
		threads: Number(values.threads),
	})

	return cached.toString()
}

async function runBattery(): Promise<void> {
	const arms: BatteryArm[] = (values.arm ?? []).map((pair) => {
		const [name, cache] = pair.split("=")

		if (!name || !cache) throw new Error(`--arm takes name=<weights cache>, got ${pair}`)

		return { name, cache }
	})

	if (arms.length < 2 || !values.out) throw new Error("two or more --arm values and --out are required")

	const baseline = values.baseline ?? arms[0]!.name
	const seeds = values.seeds?.split(",").map((seed) => seed.trim()) ?? []

	for (const name of [baseline, ...seeds]) {
		if (!arms.some((arm) => arm.name === name))
			throw new Error(`--baseline or --seeds names ${name}, which no --arm is`)
	}

	const wanted = values.suites?.split(",").map((suite) => suite.trim())
	const suites = wanted ? BATTERY_SUITES.filter((s) => wanted.includes(s.id)) : BATTERY_SUITES

	if (wanted && suites.length !== wanted.length)
		throw new Error(`--suites names a suite outside ${BATTERY_SUITES.map((s) => s.id).join(", ")}`)

	const report: BatteryReport = { arms, baseline, seeds, suites: {} }
	const names = arms.map((arm) => arm.name)

	for (const spec of suites) {
		const parses = new Map<string, Map<string, BatterySpan[]>>()

		for (const arm of arms) {
			const map = new Map<string, BatterySpan[]>()

			for await (const p of JSONSpliterator.fromAsync<{ id: string; spans: BatterySpan[] }>(
				await parsesFor(arm, spec)
			)) {
				map.set(p.id, p.spans)
			}

			parses.set(arm.name, map)
		}

		const rows: BatteryRowResult[] = []

		for await (const row of JSONSpliterator.fromAsync<BatterySuiteRow>(
			`${BATTERY_SUITE_DIR}/${spec.id}-${spec.rows}.rows.jsonl`
		)) {
			rows.push(scoreBatteryRow(spec, row, names, (arm, id) => parses.get(arm)!.get(id)))
		}

		report.suites[spec.id] = { rows }

		console.error(`${spec.id}: ${rows.length} rows scored`)
	}

	const out = values.out

	await writeLocalTextFile(formatBatteryReport(report, new Date().toISOString()), `${out}.md`)
	await writeLocalJSONFile(report, `${out}.json`)

	console.error(`wrote ${out}.md and ${out}.json`)
}
