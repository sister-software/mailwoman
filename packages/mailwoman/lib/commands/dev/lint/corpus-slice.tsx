/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev lint corpus-slice --database <parquet> --stats <stats.json>` — corpus linter:
 *   compares a new recipe-output parquet against pre-computed corpus statistics (see `mailwoman corpus
 *   stats`) and flags the v0.6.2 "5th Avenue Theatre" class of poisoning patterns. Markdown report on
 *   stdout. exits 1 when any error-severity flag fires (warnings don't check).
 *
 *   The command keeps its name: the router resolves a command by its file path, and a renamed command has no
 *   `deprecatedName` the way a flag does, so the scripts and runbooks that type it would break silently.
 */

import { type CommandSpec, CommandTaskResult, type CommandComponent, reportToStderr, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "corpus-slice",
	description: "Lint a recipe-output parquet against pre-computed corpus statistics.",
	options: {
		database: { type: "string", required: true, description: "The recipe-output parquet to lint" },
		stats: { type: "string", required: true, description: "Pre-computed corpus stats JSON" },
		rules: { type: "string", description: "Anti-pattern rules JSON (default: the bundled lint-rules.json)" },
		"out-md": { type: "string", description: "Write the markdown report here as well as stdout" },
		"out-json": { type: "string", description: "Write a JSON sidecar of the flags + summary here" },
	},
} as const satisfies CommandSpec

const DevLintCorpusRecipeOutput: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { lintRecipeOutput } = await import("@mailwoman/corpus/tools")

			return lintRecipeOutput(
				{
					recipeOutputPath: options.database,
					statsPath: options.stats,
					rulesPath: options.rules,
					outMd: options.outMd,
					outJSON: options.outJSON,
				},
				reportToStderr
			)
		},
		(summary) => (summary.errors > 0 ? 1 : 0)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	// The tool writes its verdict to stderr, so the component has no additional result frame.
	return null
}

export default DevLintCorpusRecipeOutput
