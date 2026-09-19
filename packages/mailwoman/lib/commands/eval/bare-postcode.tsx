/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval bare-postcode` — parse the 56 globally reserved postcode inputs with one warm
 *   classifier. Exit 0 requires every first token to decode as postcode.
 */

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Read the 56 reserved bare-postcode capability cases with one warm classifier"

/**
 * Native command-line interface consumed by the filesystem command router.
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

const EvalBarePostcode = harnessCommand(
	spec,
	async (options) => {
		const { runBarePostcodeCapability } = await import("#eval-harness/bare-postcode-capability")

		return runBarePostcodeCapability({ weightsCacheRoot: options.weightsCache, label: options.label })
	},
	{ exitCode: (result) => (result.pass ? 0 : 1) }
)

export default EvalBarePostcode
