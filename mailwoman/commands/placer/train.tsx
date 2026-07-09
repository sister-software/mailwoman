/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman placer train` — train the coarse placer (#244): a multinomial logistic regression
 *   over hashed char-n-gram + script features via plain SGD (CPU-only, a few minutes — no
 *   GPU/Modal). Fits a val-NLL temperature and writes the `meta.json` + `weights.bin` artifact.
 */

import { trainCoarsePlacer } from "@mailwoman/core/coarse-placer/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

export const description = "Train the coarse placer (#244) — SGD logistic regression, CPU-only"

const OptionsSchema = zod.object({
	epochs: zod.number().default(12).describe("SGD epochs"),
	lr: zod.number().default(0.1).describe("Initial learning rate (decays per epoch)"),
	l2: zod.number().default(0.000001).describe("L2 regularization"),
	out: zod.string().optional().describe("Artifact dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model)"),
	data: zod.string().optional().describe("Dataset dir (default <repo>/data/coarse-placer)"),
})

export { OptionsSchema as options }

const report = (line: string): void => console.error(line)

const PlacerTrain: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		trainCoarsePlacer(
			{ epochs: options.epochs, lr: options.lr, l2: options.l2, out: options.out, data: options.data },
			report
		)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { outDir, trainRows, temperature } = state.result

		return (
			<Text color="green">
				trained on {trainRows.toLocaleString()} rows (T={temperature.toFixed(2)}) → {outDir}
			</Text>
		)
	}

	return null
}

export default PlacerTrain
