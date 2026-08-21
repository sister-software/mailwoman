/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman placer eval <kind>` — the coarse placer (#244) eval suite, one enum command. Kinds:
 *   `in-distribution` (accuracy + per-class + ECE + multi-script abstention), `openset` (the M2
 *   post-hoc open-set score Pareto), `latin-offmap` (the M3 Latin off-map handled-rate), and
 *   `quant-compare` (int8 vs fp32 gate). Every kind emits its report to stdout; all need the
 *   dataset + model artifacts locally — operator-run, not CI.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Evaluate the coarse placer (#244): in-distribution | openset | latin-offmap | quant-compare"

const kinds = ["in-distribution", "openset", "latin-offmap", "quant-compare"] as const

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "eval",
	description,
	positionals: [{ name: "kind", required: true, choices: kinds, description: "Eval kind" }],
	options: {
		model: { type: "string", description: "Model artifact dir" },
		data: { type: "string", description: "Dataset dir" },
		abstain: { type: "number", description: "Abstention threshold" },
		"fit-per-class": { type: "number", description: "Mahalanobis fit rows per class" },
		"out-md": { type: "string", description: "Markdown report" },
		fp32: { type: "string", description: "fp32 artifact dir" },
		int8: { type: "string", description: "int8 artifact dir" },
	},
} as const satisfies CommandSpec

interface Options {
	model?: string
	data?: string
	abstain?: number
	fitPerClass?: number
	outMd?: string
	fp32?: string
	int8?: string
}

type Kind = (typeof kinds)[number]

const report = (line: string): void => console.error(line)

async function runKind(kind: Kind, options: Options): Promise<string> {
	const { evalCoarsePlacer, evalLatinOffmap, evalOpenSet, evalQuantCompare } =
		await import("@mailwoman/core/coarse-placer/tools")

	switch (kind) {
		case "in-distribution": {
			const res = await evalCoarsePlacer({ model: options.model, abstain: options.abstain, data: options.data })

			return `in-distribution: ${res.accuracy.toFixed(2)}% accuracy over ${res.n} rows (ECE ${res.ece.toFixed(4)})`
		}
		case "openset": {
			const res = await evalOpenSet(
				{ model: options.model, data: options.data, fitPerClass: options.fitPerClass, outMd: options.outMd },
				report
			)

			return `openset: best score \`${res.winner}\` at honest min ${res.honestMin.toFixed(1)} — ${res.clears90 ? "clears" : "below"} 90/90`
		}
		case "latin-offmap": {
			const res = await evalLatinOffmap({ model: options.model, abstain: options.abstain, data: options.data })

			return `latin-offmap: ${res.handled}/${res.n} handled (OTHER-or-abstain)`
		}
		case "quant-compare": {
			const res = await evalQuantCompare({
				fp32: options.fp32,
				int8: options.int8,
				abstain: options.abstain,
				data: options.data,
			})

			return `quant-compare: fp32 ${res.accFp32.toFixed(2)}% vs int8 ${res.accInt8.toFixed(2)}% — ${res.pass ? "PASS" : "FAIL"}`
		}
	}
}

const PlacerEval: ParsedCommandComponent<Options, [Kind]> = ({ options, args }) => {
	const state = useCommandTask(async () => runKind(args[0], options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">{state.result}</Text>

	return null
}

export default PlacerEval
