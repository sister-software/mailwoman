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

import { evalCoarsePlacer, evalLatinOffmap, evalOpenSet, evalQuantCompare } from "@mailwoman/core/coarse-placer/tools"
import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

export const description = "Evaluate the coarse placer (#244): in-distribution | openset | latin-offmap | quant-compare"

export const args = zod.tuple([
	zod.enum(["in-distribution", "openset", "latin-offmap", "quant-compare"]).describe(
		argument({
			name: "kind",
			description: "Eval kind (in-distribution, openset, latin-offmap, quant-compare)",
		})
	),
])

const OptionsSchema = zod.object({
	model: zod.string().optional().describe("Model artifact dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model)"),
	data: zod.string().optional().describe("Dataset dir (default <repo>/data/coarse-placer)"),
	abstain: zod.number().optional().describe("in-distribution/latin-offmap: abstention threshold (default 0.5)"),
	fitPerClass: zod.number().optional().describe("openset: Mahalanobis fit rows per class (default 2000)"),
	outMd: zod.string().optional().describe("openset: also write the markdown report here"),
	fp32: zod
		.string()
		.optional()
		.describe("quant-compare: fp32 artifact dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model)"),
	int8: zod
		.string()
		.optional()
		.describe("quant-compare: int8 artifact dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model-int8)"),
})

export { OptionsSchema as options }

type Options = zod.infer<typeof OptionsSchema>
type Kind = zod.infer<typeof args>[0]

const report = (line: string): void => console.error(line)

async function runKind(kind: Kind, options: Options): Promise<string> {
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

const PlacerEval: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(() => runKind(args[0], options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">{state.result}</Text>

	return null
}

export default PlacerEval
