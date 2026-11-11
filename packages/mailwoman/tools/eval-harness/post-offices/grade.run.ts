/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grades the post-office parse suite through the runtime pipeline, the path `mailwoman parse` parses
 *   through, and exits non-zero when any row fails. The suite is a must-pass floor: its contract is 100%.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/post-offices/grade.run.ts \
 *     --suite <directory build.run.ts wrote> [--out <report prefix>] [--weights-cache <cache>] [--workers <n>]
 *
 *   Rows are parsed per weights locale, as the release configuration maps each row's country, with the
 *   row's country as the locale hint. The report states the rows and each component's failures with their
 *   denominators, then each failing input beside the expected and observed text of each failing component.
 *   `--out` also writes `<out>.json` (every row's grade) and `<out>.txt` (the report).
 */

import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { availableParallelism } from "@mailwoman/core/utils/system"
import { resolvePath } from "path-ts"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { heldoutWeightsLocale, readHeldoutLocalePackages } from "#tools/eval-harness/heldout/per/country"
import { parsePipelineRows } from "#tools/eval-harness/pipeline-parse/rows"
import { POST_OFFICE_SUITE_ID } from "#tools/eval-harness/post-offices/build"
import {
	gradePostOfficeRow,
	type PostOfficeRowGrade,
	postOfficeSuiteReport,
	summarizePostOfficeGrades,
} from "#tools/eval-harness/post-offices/grade"
import type { PostOfficeSuiteRow } from "#tools/eval-harness/post-offices/rows"

const { values } = parseArguments({
	options: {
		suite: { type: "string", description: "The directory build.run.ts wrote the suite to" },
		out: { type: "string", description: "Report prefix; writes <out>.json and <out>.txt" },
		"weights-cache": { type: "string", description: "A package-shaped weights cache (default: installed packages)" },
		workers: {
			type: "string",
			// A parse is CPU-bound, so the pool scales to the core count.
			// The main thread keeps one core.
			default: String(Math.max(1, availableParallelism() - 1)),
			description: "Parse worker threads (default: one per core, less one)",
		},
		threads: { type: "string", default: "1", description: "ONNX threads per parse worker" },
	},
})

if (!values.suite) throw new Error("--suite <directory> is required")

const { manifest, rows } = await readHeldoutDatasetRows(resolvePath(values.suite, `${POST_OFFICE_SUITE_ID}.json`))
const suiteRows = rows as PostOfficeSuiteRow[]
const packages = await readHeldoutLocalePackages()
const byLocale = Map.groupBy(suiteRows, (row) => heldoutWeightsLocale(row.country, packages))

const grades: PostOfficeRowGrade[] = []

for (const [locale, localeRows] of byLocale) {
	const parses = await parsePipelineRows(
		localeRows.map((row, index) => ({ id: String(index), raw: row.raw, localeHint: row.country })),
		{
			locale,
			workers: Number(values.workers),
			threads: Number(values.threads),
			...(values["weights-cache"] ? { cacheRoot: values["weights-cache"] } : {}),
			onProgress: (parsed, total) => console.error(`[post-offices] ${locale}: ${parsed} of ${total} parsed`),
		}
	)

	localeRows.forEach((row, index) => grades.push(gradePostOfficeRow(row, parses[index]!)))
}

const report = postOfficeSuiteReport(grades)

if (values.out) {
	await writeLocalJSONFile(
		{
			suite: { datasetID: manifest.datasetID, version: manifest.version, rowsSHA256: manifest.rowsFile.sha256 },
			weightsCache: values["weights-cache"] ?? null,
			summary: summarizePostOfficeGrades(grades),
			grades,
		},
		`${values.out}.json`
	)

	await writeLocalTextFile(report, `${values.out}.txt`)
}

console.log(report.join("\n"))

if (grades.some((grade) => !grade.pass)) {
	process.exitCode = 1
}
