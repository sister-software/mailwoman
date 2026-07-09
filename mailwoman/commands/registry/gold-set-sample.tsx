/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry gold-set-sample` — sample the HARD co-located name-collision slice (#625
 *   gold-set P3) as JSONL rows for adjudication. Without `--out-jsonl` the first 10 rows print to
 *   stdout.
 */

import { goldSetSample } from "@mailwoman/registry/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	sources: zod
		.string()
		.optional()
		.describe("Record-matcher sources dir (default $MAILWOMAN_DATA_ROOT/record-matcher/sources)"),
	cap: zod.number().default(200000).describe("Providers sampled from the registry"),
	state: zod.string().default("TX").describe("State filter"),
	tau: zod.number().default(0.7).describe("Org-name Jaccard collision threshold"),
	n: zod.number().default(300).describe("Adjudication sample size (deterministic stride sample)"),
	outJsonl: zod.string().optional().describe("Write the sampled pairs here as JSONL"),
})

export { OptionsSchema as options }

const RegistryGoldSetSample: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		goldSetSample(
			{
				sources: options.sources,
				cap: options.cap,
				state: options.state,
				tau: options.tau,
				n: options.n,
				outJsonl: options.outJsonl,
			},
			(line) => console.error(line)
		)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				gold-set-sample: {state.result.sampled} of {state.result.hardPairs} hard pairs sampled
			</Text>
		)
	}

	return null
}

export default RegistryGoldSetSample
