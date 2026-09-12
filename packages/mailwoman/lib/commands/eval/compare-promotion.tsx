/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval compare-promotion` — compare two promotion-evaluation output directories.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Compare promotion-evaluation outputs before accepting a performance change"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "compare-promotion",
	description,
	options: {
		baseline: { type: "string", description: "Promotion output directory before the change" },
		candidate: { type: "string", description: "Promotion output directory after the change" },
	},
} as const satisfies CommandSpec

interface Options {
	baseline?: string
	candidate?: string
}

const ComparePromotion: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			if (!options.baseline || !options.candidate) {
				console.error("✗ --baseline and --candidate are required")

				return 2
			}

			const { comparePromotionOutputs } = await import("#eval-harness/promotion/eval/compare")
			const comparison = await comparePromotionOutputs(options.baseline, options.candidate)

			if (comparison.equal) {
				console.log("Promotion outputs match: every file is unchanged; verdict.json.generated_at_dir was ignored.")

				return 0
			}

			for (const difference of comparison.differences) {
				console.error(`✗ ${difference.path}: baseline ${difference.baseline}; candidate ${difference.candidate}`)
			}

			return 1
		},
		(exitCode) => exitCode
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default ComparePromotion
