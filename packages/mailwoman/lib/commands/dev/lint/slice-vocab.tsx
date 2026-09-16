/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev lint slice-vocab --parquet <recipe-output.parquet>` — the #511 base-consistency lint,
 *   country-scoped (v2): flags any token a synthetic recipe output labels one tag while the BASE corpus
 *   dominantly labels it another. Affix-split rows (the recipe output's street_suffix/_prefix vs base
 *   "street") are surfaced separately — the loader's affix-relabel handles them. Exits 1 on any real
 *   contradiction.
 *
 *   The command keeps its name: the router resolves a command by its file path, and a renamed command has no
 *   `deprecatedName` the way a flag does, so the scripts and runbooks that type it would break silently.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "slice-vocab",
	description: "Lint a synthetic recipe output against base-corpus token labels.",
	options: {
		parquet: {
			type: "string",
			required: true,
			description: "The recipe-output parquet to lint",
			deprecatedName: "slice",
		},
		"base-version": { type: "string", default: "v0.5.0", description: "Base corpus version" },
		"base-root": { type: "string", description: "Base corpus root (default $MAILWOMAN_DATA_ROOT/corpus/versioned)" },
		threshold: { type: "number", default: 0.7, description: "Base-majority confidence floor for a contradiction" },
		"min-count": { type: "number", default: 50, description: "Minimum base support to judge a token" },
		fraction: {
			type: "number",
			default: 1,
			description: "Fraction of base parts to scan (proportional per-source below 1.0)",
		},
	},
} as const satisfies CommandSpec

const DevLintRecipeOutputVocab: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { lintSliceVocab } = await import("@mailwoman/corpus/tools")

			return lintSliceVocab({
				slice: options.parquet,
				baseVersion: options.baseVersion,
				baseRoot: options.baseRoot,
				threshold: options.threshold,
				minCount: options.minCount,
				fraction: options.fraction,
			})
		},
		(summary) => (summary.errors > 0 ? 1 : 0)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done" && state.result.errors > 0) {
		return (
			<Text color="red">
				✗ {state.result.errors} contradiction(s) ({state.result.warnings} affix-split rows)
			</Text>
		)
	}

	return null
}

export default DevLintRecipeOutputVocab
