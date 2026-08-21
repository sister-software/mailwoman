/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry dedup-ceiling` — the #625 "how good is good enough" measurement: the
 *   irreducible over-merge of co-located distinct-NPI providers (the Bayes error that caps dedup
 *   precision). Geocode-free + label-free; emits the markdown report to stdout.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "dedup-ceiling",
	description: "Measure the irreducible over-merge rate for co-located providers.",
	options: {
		sources: {
			type: "string",
			description: "Record-matcher sources dir (default $MAILWOMAN_DATA_ROOT/record-matcher/sources)",
		},
		cap: { type: "number", default: 50_000, description: "Providers sampled from the registry" },
		state: { type: "string", default: "TX", description: "State filter" },
		tau: { type: "number", default: 0.7, description: "Org-name Jaccard collision threshold" },
		"out-md": { type: "string", description: "Also write the markdown report here" },
	},
} as const satisfies CommandSpec

interface Options {
	sources?: string
	cap: number
	state: string
	tau: number
	outMd?: string
}

const RegistryDedupCeiling: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dedupCeiling } = await import("@mailwoman/registry/tools")

		return dedupCeiling(
			{ sources: options.sources, cap: options.cap, state: options.state, tau: options.tau, outMd: options.outMd },
			(line) => console.error(line)
		)
	})

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
