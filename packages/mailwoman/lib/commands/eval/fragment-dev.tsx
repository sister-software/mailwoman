/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval fragment-dev` — probe-1 separator metrics on the held-out fragment split
 *   (span-exact vs tag-accuracy; trailing-number→postcode rate). See eval-harness/fragment-dev.ts.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Fragment-dev read-out — probe-1 separator metrics (span-exact vs tag accuracy)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "fragment-dev",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		"weights-cache": { type: "string", description: "Package-shaped candidate dir (see eval parity --weights-cache)" },
		fixtures: {
			type: "string",
			required: true,
			description: "fragment-dev.jsonl path (held-out split from build_fragment_shard)",
		},
		limit: {
			type: "number",
			default: 0,
			validate: Number.isInteger,
			validationMessage: "--limit must be an integer.",
			description: "Row cap for a fast read (0 = all)",
		},
	},
} as const satisfies CommandSpec

interface Options {
	locale: string
	weightsCache?: string
	fixtures: string
	limit: number
}

const EvalFragmentDev: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { runFragmentDev } = await import("#eval-harness/fragment-dev")

		await runFragmentDev({
			locale: options.locale,
			weightsCacheRoot: options.weightsCache,
			fixturesPath: options.fixtures,
			limit: options.limit,
		})

		return 0
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default EvalFragmentDev
