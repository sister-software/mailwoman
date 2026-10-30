/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Audits script transitions inside gold address components over a sample of the train mixture.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/audits/mixed-script.run.ts --config <yaml> [--corpus-dir <dir>] \
 *       [--rows 250000] [--seed 1569] [--examples-per-tag 10] [--affix-relabel-lexicon <json>] [--json <path>]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { loadTrainingConfig } from "../config.ts"
import { auditMixedScriptRows, relabeledDraws } from "./mixed-script.ts"
import { writeAuditReport } from "./receipt.ts"

const { values } = parseArguments({
	options: {
		config: { type: "string" },
		"corpus-dir": { type: "string" },
		rows: { type: "string", default: "250000" },
		seed: { type: "string", default: "1569" },
		"examples-per-tag": { type: "string", default: "10" },
		"affix-relabel-lexicon": { type: "string" },
		json: { type: "string" },
	},
})

if (!values.config) throw new Error("--config is required")

const rows = Number(values.rows)
const seed = Number(values.seed)
const mtf = await mtfNode()
const config = await loadTrainingConfig(values.config)

const report = auditMixedScriptRows(
	mtf.pythonText,
	relabeledDraws(mtf, config, {
		rows,
		seed,
		corpusDir: values["corpus-dir"],
		affixRelabelLexiconPath: values["affix-relabel-lexicon"],
	}),
	Number(values["examples-per-tag"])
)

report.set(
	"sample",
	new Map<string, unknown>([
		["rows", rows],
		["seed", seed],
		["config", values.config],
	])
)

if (values.json) {
	await writeAuditReport(values.json, report, { trailingNewline: true })
}

const totals = report.get("totals") as Map<string, number | { value: number }>
const count = (key: string) => ((totals.get(key) as number | undefined) ?? 0).toLocaleString("en-US")
const rate = (totals.get("mixed_rate") as { value: number }).value

console.log(
	`rows=${count("rows")} multiple-script=${count("rows_with_multiple_scripts")} ` +
		`mixed-component=${count("rows_with_mixed_component")} ` +
		`mixed-components=${count("mixed_components")}/${count("scripted_components")} ` +
		`(${(100 * rate).toFixed(3)}%)`
)
