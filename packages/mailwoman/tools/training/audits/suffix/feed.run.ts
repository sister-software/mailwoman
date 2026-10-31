/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Audits the suffix-boundary feed's terminal-suffix labels over a sample of the train mixture.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/audits/suffix/feed.run.ts --config <yaml> --classify-lexicon <json> \
 *       --relabel-lexicon <json> [--rows 250000] [--seed 1569] [--corpus-dir <dir>] [--json <path>]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { loadTrainingConfig } from "../../config.ts"
import { writeAuditReport } from "../receipt.ts"
import { readAffixLexicon, suffixFeedAudit } from "./feed.ts"

const { values } = parseArguments({
	options: {
		config: { type: "string" },
		"classify-lexicon": { type: "string" },
		"relabel-lexicon": { type: "string" },
		rows: { type: "string", default: "250000" },
		seed: { type: "string", default: "1569" },
		"corpus-dir": { type: "string" },
		json: { type: "string" },
	},
})

const configPath = values.config
const classifyPath = values["classify-lexicon"]
const relabelPath = values["relabel-lexicon"]

if (!configPath || !classifyPath || !relabelPath) {
	throw new Error("--config, --classify-lexicon and --relabel-lexicon are required")
}

const config = await loadTrainingConfig(configPath)
const classifyLexicon = await readAffixLexicon(classifyPath)

if (!classifyLexicon.nameProne.size) {
	throw new Error(
		`classify lexicon ${classifyPath} has no name_prone vocabulary — classification needs the v2 artifact ` +
			"(the class definitions live in its name-prone set)"
	)
}

const relabelLexicon = await readAffixLexicon(relabelPath)

const audit = suffixFeedAudit(await mtfNode(), config, {
	seed: Number(values.seed),
	rows: Number(values.rows),
	classifyLexicon,
	relabelLexiconPath: relabelPath,
	relabelLexiconVersion: relabelLexicon.version,
	corpusDir: values["corpus-dir"],
})

const report = { ...audit, meta: { ...audit.meta, config: configPath } }

if (values.json) {
	await writeAuditReport(values.json, report, { trailingNewline: true })
}

const { terminal_only: only, terminal_contrast: contrast } = report
const count = (n: number) => n.toLocaleString("en-US")

console.log(
	`=== terminal-only feed audit (${count(report.meta.rows_sampled)} rows, relabel=${report.meta.relabel_lexicon}) ===`
)
console.log(`terminal-only  target:   ${count(only.target.correct)}/${count(only.target.carriers)}`)
console.log(`terminal-only  ordinary: ${count(only.ordinary.correct)}/${count(only.ordinary.carriers)}`)
console.log(`contrast       target:   ${count(contrast.target.correct)}/${count(contrast.target.carriers)}`)
console.log(`contrast       ordinary: ${count(contrast.ordinary.correct)}/${count(contrast.ordinary.carriers)}`)
