/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman placer quantize` — int8-quantize the coarse placer (#244) weights (per-class
 *   symmetric scales, 4× smaller). Verify the accuracy cost with `placer eval quant-compare`.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
} from "#cli-kit"

export const description = "Int8-quantize the coarse placer (#244) weights (4× smaller)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "quantize",
	description,
	options: {
		in: { type: "string", description: "Fp32 artifact dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model)" },
		out: { type: "string", description: "Int8 output dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model-int8)" },
	},
} as const satisfies CommandSpec

interface Options {
	in?: string
	out?: string
}

const PlacerQuantize: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { quantizeCoarsePlacer } = await import("@mailwoman/core/coarse-placer/tools")

		return quantizeCoarsePlacer({ in: options.in, out: options.out }, reportToStderr)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		const { outDir, fp32Bytes, int8Bytes } = state.result

		return (
			<Text color="green">
				{`${ByteFormatter.formatIEC(fp32Bytes)} fp32 → ${ByteFormatter.formatIEC(int8Bytes)} int8 → ${outDir}`}
			</Text>
		)
	}

	return null
}

export default PlacerQuantize
