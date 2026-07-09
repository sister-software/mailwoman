/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman placer probe-frontier` — the #822 frontier probe: can the DEPLOYED coarse placer
 *   (#244) emit the placer-recoverable countries? Emits the branch verdict (data gap /
 *   under-confident / low-quality signal / no change) that drives the Phase-2 fix choice.
 */

import { probeFrontier } from "@mailwoman/core/coarse-placer/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

export const description = "Probe whether the deployed coarse placer (#244) covers the recoverable tranche (#822)"

const OptionsSchema = zod.object({
	model: zod
		.string()
		.optional()
		.describe("Model artifact dir (default: the deployed bundle in @mailwoman/core, core/data/coarse-placer)"),
	n: zod.number().default(2000).describe("Queries sampled from cities15000 (shortest first)"),
	out: zod.string().optional().describe("Also write the markdown report here"),
})

export { OptionsSchema as options }

const report = (line: string): void => console.error(line)

const PlacerProbeFrontier: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => probeFrontier({ model: options.model, n: options.n, out: options.out }, report))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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
