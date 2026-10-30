/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grades one or more models on the frozen OpenStreetMap suites `build.run.ts` wrote, parsing each suite across
 *   worker threads with `gradeOSMSuite`, and writes `<out>.json` (every arm's per-suite and per-country exact
 *   parse totals) and `<out>.md` (the per-suite table).
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/osm-suites/grade.run.ts \
 *     --suites <directory build.run.ts wrote> --arm shipped=<weights cache> --arm b42=<weights cache> \
 *     --out <report prefix> [--workers 3] [--threads 2]
 *
 *   Each weights cache is package-shaped and holds every locale package the release configuration maps a
 *   country to (the `full-cache` layout the comparison battery reads). A row is exact when every annotated
 *   span matches under the country's street convention, as the held-out grader scores it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { resolvePath } from "path-ts"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { readHeldoutLocalePackages } from "#tools/eval-harness/heldout/per/country"
import type { OSMSuiteRow } from "#tools/eval-harness/osm-suites/extract"
import { gradeOSMSuite, type SuiteCountryTotal, totalSuiteOutcomes } from "#tools/eval-harness/osm-suites/grade"
import { OSMSuiteShape } from "#tools/eval-harness/osm-suites/shapes"

const { values } = parseArguments({
	options: {
		suites: { type: "string", description: "The directory build.run.ts wrote the suites to" },
		arm: { type: "string", multiple: true, description: "name=<weights cache>, once per arm" },
		out: { type: "string", description: "Report prefix; writes <out>.json and <out>.md" },
		workers: { type: "string", default: "3", description: "Parse worker threads" },
		threads: { type: "string", default: "2", description: "ONNX threads per parse worker" },
	},
})

if (!values.suites || !values.out) throw new Error("--suites <directory> and --out <prefix> are required")

const arms = (values.arm ?? []).map((pair) => {
	const [name, cache] = pair.split("=")

	if (!name || !cache) throw new Error(`--arm takes name=<weights cache>, got ${pair}`)

	return { name, cache }
})

if (!arms.length) throw new Error("name one or more --arm values")

const workers = Number(values.workers)
const threads = Number(values.threads)
const packages = [...(await readHeldoutLocalePackages()).entries()]

/**
 * The en-US model card of an arm's weights cache: its path, recorded version and digest.
 */
async function armModel(cache: string): Promise<{ card: string; version: string | null; sha256: string }> {
	const card = resolvePath(weightsCachePackageDir(cache, "en-us"), "model-card.json")
	const { version } = await readLocalJSONFile<{ version?: unknown }>(card)

	return {
		card: card.toString(),
		version: typeof version === "string" ? version : null,
		sha256: await sha256File(card),
	}
}

interface ArmSuiteGrade {
	rows: number
	exact: number
	countries: SuiteCountryTotal[]
}

const report = {
	suites: values.suites,
	workers,
	threads,
	arms: await Promise.all(arms.map(async (arm) => ({ ...arm, model: await armModel(arm.cache) }))),
	grades: [] as Array<{
		shape: OSMSuiteShape
		datasetID: string
		version: string
		rowsSHA256: string
		rows: number
		arms: Record<string, ArmSuiteGrade>
	}>,
}

for (const shape of Object.values(OSMSuiteShape)) {
	const { manifest, rows } = await readHeldoutDatasetRows(resolvePath(values.suites, `osm-suite-${shape}.json`))

	const grade = {
		shape,
		datasetID: manifest.datasetID,
		version: manifest.version,
		rowsSHA256: manifest.rowsFile.sha256,
		rows: rows.length,
		arms: {} as Record<string, ArmSuiteGrade>,
	}

	report.grades.push(grade)

	for (const arm of arms) {
		const started = performance.now()

		const outcomes = await Array.fromAsync(
			gradeOSMSuite(rows as OSMSuiteRow[], { cacheRoot: arm.cache, packages, intraOpNumThreads: threads }, workers)
		)

		if (outcomes.length !== rows.length) {
			throw new Error(`${arm.name} returned ${outcomes.length} outcomes for the ${rows.length} rows of ${shape}`)
		}

		const countries = totalSuiteOutcomes(outcomes)
		const exact = countries.reduce((sum, total) => sum + total.exact, 0)
		const seconds = (performance.now() - started) / 1000

		grade.arms[arm.name] = { rows: outcomes.length, exact, countries }

		console.error(
			`[osm-suites] ${shape} ${arm.name}: ${exact} of ${outcomes.length} exact, ` +
				`${(outcomes.length / seconds).toFixed(0)} rows/s`
		)
	}
}

const table = [
	`| Suite | Rows | ${arms.map((arm) => arm.name).join(" | ")} |`,
	`| --- | ---: | ${arms.map(() => "---:").join(" | ")} |`,
	...report.grades.map(
		(grade) =>
			`| ${grade.shape} | ${grade.rows.toLocaleString("en-US")} | ${arms
				.map((arm) => {
					const { exact, rows } = grade.arms[arm.name]!

					return `${formatPercent(exact, rows)} (${exact.toLocaleString("en-US")})`
				})
				.join(" | ")} |`
	),
]

await writeLocalJSONFile(report, `${values.out}.json`)

await writeLocalTextFile(
	[
		"# OpenStreetMap suites, exact parse",
		"",
		`Suites from \`${values.suites}\`. ${workers} workers × ${threads} ONNX threads. Each cell is the share of rows ` +
			"parsed exactly, with the exact count.",
		"",
		...report.arms.map(
			(arm) => `- \`${arm.name}\`: \`${arm.cache}\`, en-US card version ${arm.model.version ?? "unrecorded"}`
		),
		"",
		...table,
		"",
	].join("\n"),
	`${values.out}.md`
)

console.log(table.join("\n"))
