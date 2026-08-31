/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry gold-set-sample` — sample the HARD co-located name-collision slice (#625
 *   gold-set P3) as JSONL rows for adjudication. Without `--out-jsonl` the first 10 rows print to
 *   stdout.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "gold-set-sample",
	description: "Sample hard co-located name collisions for adjudication.",
	options: {
		sources: {
			type: "string",
			description: "Record-matcher sources dir (default $MAILWOMAN_DATA_ROOT/record-matcher/sources)",
		},
		cap: { type: "number", default: 200_000, description: "Providers sampled from the registry" },
		state: { type: "string", default: "TX", description: "State filter" },
		tau: { type: "number", default: 0.7, description: "Org-name Jaccard collision threshold" },
		n: { type: "number", default: 300, description: "Adjudication sample size (deterministic stride sample)" },
		"out-jsonl": { type: "string", description: "Write the sampled pairs here as JSONL" },
	},
} as const satisfies CommandSpec

interface Options {
	sources?: string
	cap: number
	state: string
	tau: number
	n: number
	outJSONL?: string
}

const RegistryGoldSetSample: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { goldSetSample } = await import("@mailwoman/registry/tools")

		return goldSetSample(
			{
				sources: options.sources,
				cap: options.cap,
				state: options.state,
				tau: options.tau,
				n: options.n,
				outJSONL: options.outJSONL,
			},
			(line) => console.error(line)
		)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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
