/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman placer train` — train the coarse placer (#244): a multinomial logistic regression
 *   over hashed char-n-gram + script features via plain SGD (CPU-only, a few minutes — no
 *   GPU/Modal). Fits a val-NLL temperature and writes the `meta.json` + `weights.bin` artifact.
 */

import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
} from "#cli-kit"

export const description = "Train the coarse placer (#244) — SGD logistic regression, CPU-only"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "train",
	description,
	options: {
		epochs: { type: "number", default: 12, description: "SGD epochs" },
		lr: { type: "number", default: 0.1, description: "Initial learning rate (decays per epoch)" },
		l2: { type: "number", default: 0.000001, description: "L2 regularization" },
		out: { type: "string", description: "Artifact dir (default $MAILWOMAN_DATA_ROOT/coarse-placer/model)" },
		data: { type: "string", description: "Dataset dir (default <repo>/data/coarse-placer)" },
	},
} as const satisfies CommandSpec

interface Options {
	epochs: number
	lr: number
	l2: number
	out?: string
	data?: string
}

const PlacerTrain: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { trainCoarsePlacer } = await import("@mailwoman/core/coarse-placer/tools")

		return trainCoarsePlacer(
			{ epochs: options.epochs, lr: options.lr, l2: options.l2, out: options.out, data: options.data },
			reportToStderr
		)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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
