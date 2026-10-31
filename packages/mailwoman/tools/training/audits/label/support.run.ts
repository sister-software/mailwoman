/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Prints each declared split's rows per head label and the config's label floors. Exits non-zero when a floor is
 *   missed, after the report is written.
 *
 *   Usage: node packages/mailwoman/tools/training/audits/label/support.run.ts <config> [--json <path>]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { loadTrainingConfig } from "../../config.ts"
import { writeAuditReport } from "../receipt.ts"
import { labelSupportReport } from "./support.ts"

const { values, positionals } = parseArguments({ allowPositionals: true, options: { json: { type: "string" } } })
const [configPath] = positionals

if (!configPath) throw new Error("expected the training config's path")

const name = configPath.split("/").at(-1) ?? configPath
const { report, error } = labelSupportReport(await mtfNode(), await loadTrainingConfig(configPath), name)

console.log(`label support — ${name}`)

for (const [split, { rows, rows_with_label }] of Object.entries(report.splits)) {
	console.log(`  ${split} — ${(rows ?? 0).toLocaleString("en-US")} rows`)

	for (const [label, count] of Object.entries(rows_with_label ?? {}).toSorted((a, b) => a[1] - b[1])) {
		console.log(`    ${label.padStart(20)} ${count.toLocaleString("en-US").padStart(9)}`)
	}
}

if (values.json) {
	await writeAuditReport(values.json, report)
}

if (error) {
	console.error(error.message)

	process.exitCode = 1
}
