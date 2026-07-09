/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman placer quantize` — int8-quantize the coarse placer (#244) weights (per-class
 *   symmetric scales, 4× smaller). Verify the accuracy cost with `placer eval quant-compare`.
 */

import { quantizeCoarsePlacer } from "@mailwoman/core/coarse-placer/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

export const description = "Int8-quantize the coarse placer (#244) weights (4× smaller)"

const OptionsSchema = zod.object({
	in: zod.string().optional().describe("Fp32 artifact dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model)"),
	out: zod.string().optional().describe("Int8 output dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model-int8)"),
})

export { OptionsSchema as options }

const report = (line: string): void => console.error(line)

const PlacerQuantize: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => quantizeCoarsePlacer({ in: options.in, out: options.out }, report))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { outDir, fp32Bytes, int8Bytes } = state.result

		return (
			<Text color="green">
				{(fp32Bytes / 1e6).toFixed(2)} MB fp32 → {(int8Bytes / 1e6).toFixed(2)} MB int8 → {outDir}
			</Text>
		)
	}

	return null
}

export default PlacerQuantize
