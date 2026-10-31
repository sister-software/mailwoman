/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Prints each held-out split's rows and street rows per country, the countries with no street-level validation
 *   signal, and the config's declared coverage floors. Exits non-zero when a floor is missed, after the report is
 *   written.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/audits/validation/coverage.run.ts <config> [--json <path>] \
 *       [--corpus-dir <dir>] [--countries US,FR,DE,GB]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { loadTrainingConfig } from "../../config.ts"
import { writeAuditReport } from "../receipt.ts"
import { validationCoverageReport } from "./coverage.ts"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		json: { type: "string" },
		"corpus-dir": { type: "string" },
		countries: { type: "string", default: "US,FR,DE,GB" },
	},
})

const [configPath] = positionals

if (!configPath) throw new Error("expected the training config's path")

const countries = values.countries
	.split(",")
	.map((code) => code.trim().toUpperCase())
	.filter((code) => code !== "")

const { report, required, error } = validationCoverageReport(await mtfNode(), await loadTrainingConfig(configPath), {
	countries,
	corpusDir: values["corpus-dir"],
})

const count = (n: number) => n.toLocaleString("en-US")

console.log(`validation coverage — ${configPath.split("/").at(-1)}`)
console.log(`  corpus ${report.corpus_dir}`)

for (const [split, measured] of Object.entries(report.splits)) {
	console.log(`  ${split} — ${measured.files} files, ${count(measured.rows)} rows, ${measured.countries} countries`)

	for (const [country, entry] of Object.entries(measured.by_country).slice(0, 20)) {
		const share = entry.rows ? (100 * entry.street_rows) / entry.rows : 0

		console.log(
			`    ${country.padStart(8)} ${count(entry.rows).padStart(14)} ${count(entry.street_rows).padStart(14)} ${share.toFixed(1).padStart(12)}%`
		)
	}
}

for (const [country, perSplit] of Object.entries(report.blind)) {
	for (const [split, reason] of Object.entries(perSplit)) {
		console.log(`  ${country} / ${split}: ${reason}`)
	}
}

if (required.length) {
	console.log(`  declared coverage floors: ${required.length}`)
}

if (values.json) {
	await writeAuditReport(values.json, report)
}

if (error) {
	console.error(error.message)

	process.exitCode = 1
}
