// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The prominent-place coverage receipt (`coverage.ts`): presence, demand share
 *   and label coherence of each country's prominent places in the config's corpus.
 *
 *   Exits non-zero when a rule fails, after the report is written.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/audits/prominent/coverage.run.ts <config> [--json <path>] \
 *       [--places <places.parquet>]
 *
 *   `--places` overrides the config's `data.prominent_place_coverage`.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { loadTrainingConfig } from "../../config.ts"
import { hostPath } from "../../sampler.ts"
import { writeAuditReport } from "../receipt.ts"
import { prominentCoverageReport } from "./coverage.ts"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		json: { type: "string" },
		places: { type: "string" },
		"memory-gb": { type: "string", default: "6" },
		threads: { type: "string", default: "4" },
	},
})

const [configPath] = positionals

if (!configPath) throw new Error("expected the training config's path")

const config = await loadTrainingConfig(configPath)
const places = values.places ?? config.data.prominent_place_coverage

if (!places) throw new Error(`${configPath} names no data.prominent_place_coverage, and no --places was given`)

const report = await prominentCoverageReport({
	places: hostPath(places),
	manifest: `${hostPath(config.data.corpus_dir).replace(/\/+$/, "")}/MANIFEST.json`,
	limits: { memoryLimitBytes: Number(values["memory-gb"]) * 1024 ** 3, threads: Number(values.threads) },
	log: (line) => console.error(line),
})

const { presence, demand_share: demand, coherence } = report

console.log(`prominent place coverage — ${configPath.split("/").at(-1)}`)
console.log(`  presence: ${presence.covered_forms} of ${presence.required_forms} required forms covered`)
console.log(`  demand share: ${demand.passing} of ${demand.cells} cells reach half of decile 1's population share`)
console.log(`  coherence: ${coherence.rows} short admin train rows write a dependent locality without a locality`)

if (values.json) {
	await writeAuditReport(values.json, report)
}

if (!report.passed) {
	console.error("prominent_place_coverage: failed")

	process.exitCode = 1
}
