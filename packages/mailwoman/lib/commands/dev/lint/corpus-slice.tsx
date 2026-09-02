/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev lint corpus-database --database <parquet> --stats <stats.json>` — corpus linter:
 *   compares a new database against pre-computed corpus statistics (see `mailwoman corpus stats`) and
 *   flags the v0.6.2 "5th Avenue Theatre" class of poisoning patterns. Markdown report on stdout;
 *   exits 1 when any error-severity flag fires (warnings don't check).
 */

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "corpus-database",
	description: "Lint a corpus database against pre-computed statistics.",
	options: {
		database: { type: "string", required: true, description: "The new database parquet to lint" },
		stats: { type: "string", required: true, description: "Pre-computed corpus stats JSON" },
		rules: { type: "string", description: "Anti-pattern rules JSON (default: the bundled lint-rules.json)" },
		"out-md": { type: "string", description: "Write the markdown report here as well as stdout" },
		"out-json": { type: "string", description: "Write a JSON sidecar of the flags + summary here" },
	},
} as const satisfies CommandSpec

interface Options {
	database: string
	stats: string
	rules?: string
	outMd?: string
	outJSON?: string
}

const DevLintCorpusDatabase: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { lintCorpusSlice } = await import("@mailwoman/corpus/tools")

			return lintCorpusSlice(
				{
					slicePath: options.database,
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

export default DevLintCorpusDatabase
