/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Evaluates a release-requirement specification against a held-out report from `heldout/per/country.run.ts`
 *   and writes the verdict JSON, printing a readable table.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/release/evaluate.run.ts \
 *     --spec <spec .json> --report <held-out report .json> --published-arm <arm> --candidate-arm <arm> \
 *     --out <verdict .json>
 *
 *   Each arm names one of the report's `arms` entries, a package-shaped weights directory whose `model.onnx`
 *   is hashed and compared with the specification's registered identity. A missing model file is refused.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import { evaluateReleaseSpec, type OutcomeRow, pairOutcomes } from "#tools/eval-harness/release/evaluate"
import { readReleaseSpec } from "#tools/eval-harness/release/requirements"

const { values } = parseArguments({
	options: {
		spec: {
			type: "string",
			description: "The release-requirement specification",
		},
		report: {
			type: "string",
			description: "The held-out report holding per-row outcomes",
		},
		"published-arm": {
			type: "string",
			description: "The report arm holding the published model",
		},
		"candidate-arm": {
			type: "string",
			description: "The report arm holding the release candidate",
		},
		out: { type: "string", description: "Where to write the verdict" },
	},
})

if (!values.spec || !values.report || !values["published-arm"] || !values["candidate-arm"] || !values.out) {
	throw new Error("--spec, --report, --published-arm, --candidate-arm and --out are required")
}

const spec = await readReleaseSpec(values.spec)

const report = await readLocalJSONFile<{
	outcomes?: Array<{ arm?: unknown; rows?: unknown }>
	inference?: { rule?: unknown }
}>(values.report)

const inferenceRule = typeof report.inference?.rule === "string" && report.inference.rule ? report.inference.rule : null

if (!Array.isArray(report.outcomes)) throw new Error(`${values.report} holds no outcomes array`)

const armRows = (arm: string): OutcomeRow[] => {
	const entry = report.outcomes!.find((candidate) => candidate.arm === arm)

	if (!entry) throw new Error(`${values.report} holds no outcomes for arm ${arm}`)

	if (!Array.isArray(entry.rows)) throw new Error(`${values.report} arm ${arm} holds no rows array`)

	return entry.rows as OutcomeRow[]
}

const paired = pairOutcomes(armRows(values["published-arm"]), armRows(values["candidate-arm"]))

const artifacts = {
	published: await sha256File(resolvePath(values["published-arm"], "model.onnx")),
	candidate: await sha256File(resolvePath(values["candidate-arm"], "model.onnx")),
}

const verdict = evaluateReleaseSpec(spec, paired, artifacts, { rule: inferenceRule })

await writeLocalJSONFile({ spec: values.spec, report: values.report, ...verdict }, values.out)

const show = (value: number | null) => (value == null ? "n/a" : value.toFixed(4))

console.log(`spec ${verdict.specVersion}: ${verdict.outcome}`)

for (const reason of verdict.reasons) {
	console.log(`  ${reason}`)
}

console.log(["check", "kind", "rows", "groups", "estimate", "lower", "upper", "threshold", "outcome"].join("\t"))

for (const check of verdict.checks) {
	console.log(
		[
			check.id,
			check.check,
			check.rows,
			check.groups,
			show(check.estimate),
			show(check.lower),
			show(check.upper),
			show(check.threshold),
			`${check.outcome}${check.reasons.length ? ` (${check.reasons.join("; ")})` : ""}`,
		].join("\t")
	)
}

console.log(["provenance", "minimum", "comparative", "rows", "Q published", "Q candidate"].join("\t"))

for (const cls of verdict.provenance) {
	console.log(
		[
			cls.provenance,
			cls.admitted.minimum,
			cls.admitted.comparative,
			cls.rows,
			show(cls.qPublished),
			show(cls.qCandidate),
		].join("\t")
	)
}

console.log(`inference: ${verdict.inference.rule ?? "unrecorded"}`)

for (const [locale, rows] of Object.entries(verdict.inference.rowsByWeightsLocale)) {
	console.log(`  ${locale}\t${rows}`)
}
