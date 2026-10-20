/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the release-evaluator simulation over a scenario file and writes the per-scenario report JSON,
 *   printing a Markdown table. Every threshold in the scenario file is a simulation parameter.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/release/simulate.run.ts \
 *     --scenarios packages/mailwoman/tools/eval-harness/release/simulation-scenarios.json \
 *     --repetitions 200 --seed 2763 --out <report .json> [--only <scenario id>]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import {
	type Rate,
	type ScenarioReport,
	type SimulationScenario,
	simulateScenario,
} from "#tools/eval-harness/release/simulate"

const { values } = parseArguments({
	options: {
		scenarios: { type: "string", description: "The scenario file" },
		repetitions: { type: "string", description: "Evaluations per scenario" },
		seed: {
			type: "string",
			description: "Base seed; repetition r uses seed + r",
		},
		out: { type: "string", description: "Where to write the report" },
		only: { type: "string", description: "Run one scenario by id" },
	},
})

if (!values.scenarios || !values.repetitions || !values.seed || !values.out) {
	throw new Error("--scenarios, --repetitions, --seed and --out are required")
}

const repetitions = Number(values.repetitions)
const seed = Number(values.seed)

if (!Number.isInteger(repetitions) || !Number.isInteger(seed))
	throw new Error("--repetitions and --seed must be integers")

const file = await readLocalJSONFile<{
	note?: unknown
	scenarios?: SimulationScenario[]
}>(values.scenarios)

if (!Array.isArray(file.scenarios)) throw new Error(`${values.scenarios} holds no scenarios array`)

const selected = values.only ? file.scenarios.filter((s) => s.id === values.only) : file.scenarios

if (!selected.length) throw new Error(`no scenario matches ${values.only}`)

const started = performance.now()
const reports: Array<ScenarioReport & { seconds: number }> = []

for (const scenario of selected) {
	const t0 = performance.now()
	const report = simulateScenario(scenario, repetitions, seed)

	reports.push({ ...report, seconds: (performance.now() - t0) / 1000 })

	console.error(`${scenario.id}: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

const seconds = (performance.now() - started) / 1000

await writeLocalJSONFile(
	{
		note: "Thresholds are simulation parameters, not registered release requirements.",
		scenarioFile: values.scenarios,
		repetitions,
		seed,
		seconds,
		reports,
	},
	values.out
)

const pct = (r: Rate | null) =>
	r == null ? "n/a" : `${(100 * r.rate).toFixed(1)} [${(100 * r.low).toFixed(1)}, ${(100 * r.high).toFixed(1)}]`

console.log(
	"| Scenario | Rows | Truth meets all | Pass | Joint coverage | Lowest per-check coverage | Erroneous approval | Erroneous fail | Insufficient |"
)
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")

for (const r of reports) {
	const lowest = r.checks.toSorted((a, b) => a.coverage.rate - b.coverage.rate)[0]!

	console.log(
		`| ${r.id} | ${r.rows} | ${r.truthMeetsAll ? "yes" : "no"} | ${pct(r.pass)} | ${pct(r.jointCoverage)} | ${lowest.id}: ${pct(lowest.coverage)} | ${pct(r.erroneousApproval)} | ${pct(r.erroneousFail)} | ${pct(r.insufficient)} |`
	)
}

console.log(`\nR=${repetitions}, seed ${seed}..${seed + repetitions - 1}, ${seconds.toFixed(1)} s`)
