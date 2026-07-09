/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry dedup-ceiling` — the #625 "how good is good enough" measurement: the
 *   irreducible over-merge of co-located distinct-NPI providers (the Bayes error that caps dedup
 *   precision). Geocode-free + label-free; emits the markdown report to stdout.
 */

import { dedupCeiling } from "@mailwoman/registry/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	sources: zod
		.string()
		.optional()
		.describe("Record-matcher sources dir (default $MAILWOMAN_DATA_ROOT/record-matcher/sources)"),
	cap: zod.number().default(50000).describe("Providers sampled from the registry"),
	state: zod.string().default("TX").describe("State filter"),
	tau: zod.number().default(0.7).describe("Org-name Jaccard collision threshold"),
	outMd: zod.string().optional().describe("Also write the markdown report here"),
})

export { OptionsSchema as options }

const RegistryDedupCeiling: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		dedupCeiling(
			{ sources: options.sources, cap: options.cap, state: options.state, tau: options.tau, outMd: options.outMd },
			(line) => console.error(line)
		)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				dedup-ceiling: {state.result.collide} collisions over {state.result.pairs} co-located pairs
			</Text>
		)
	}

	return null
}

export default RegistryDedupCeiling
