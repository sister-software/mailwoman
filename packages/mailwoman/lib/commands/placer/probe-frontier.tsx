/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman placer probe-frontier` — the #822 frontier probe: can the DEPLOYED coarse placer
 *   (#244) emit the placer-recoverable countries? Emits the branch verdict (data gap /
 *   under-confident / low-quality signal / no change) that drives the Phase-2 fix choice.
 */

import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
} from "#cli-kit"

export const description = "Probe whether the deployed coarse placer (#244) covers the recoverable tranche (#822)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "probe-frontier",
	description,
	options: {
		model: {
			type: "string",
			description: "Model artifact dir (default: the deployed bundle in @mailwoman/core, core/data/coarse-placer)",
		},
		n: { type: "number", default: 2000, description: "Queries sampled from cities15000 (shortest first)" },
		out: { type: "string", description: "Also write the markdown report here" },
	},
} as const satisfies CommandSpec

interface Options {
	model?: string
	n: number
	out?: string
}

const PlacerProbeFrontier: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { probeFrontier } = await import("@mailwoman/core/coarse-placer/tools")

		return probeFrontier({ model: options.model, n: options.n, out: options.out }, reportToStderr)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Text color="green">
				{state.result.n} queries → {state.result.branch}
			</Text>
		)
	}

	return null
}

export default PlacerProbeFrontier
