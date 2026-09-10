/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval bare-postcode` — parse the 56 globally reserved postcode inputs with one warm
 *   classifier. Exit 0 requires every first token to decode as postcode.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Read the 56 reserved bare-postcode capability cases with one warm classifier"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "bare-postcode",
	description,
	options: {
		"weights-cache": {
			type: "string",
			description: "Package-shaped candidate root; omit to read the shipped weights",
		},
		label: { type: "string", description: "Arm name printed above the result" },
	},
} as const satisfies CommandSpec

interface Options {
	weightsCache?: string
	label?: string
}

const EvalBarePostcode: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runBarePostcodeCapability } = await import("#eval-harness/bare-postcode-capability")

			return runBarePostcodeCapability({ weightsCacheRoot: options.weightsCache, label: options.label })
		},
		(result) => (result.pass ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default EvalBarePostcode
