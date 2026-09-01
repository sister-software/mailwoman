/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus golden promote` — promote LLM-synthesized golden-set candidates into a
 *   versioned golden dir with human-typed-likelihood filters + dedup. Companion to `corpus golden
 *   expand`. Forward-copies the prior version's entries + non-JSONL files and writes a MANIFEST
 *   with per-file sha256.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "promote",
	description: "Promote reviewed golden-set candidates.",
	options: {
		input: { type: "string", required: true, description: "Candidates JSONL from corpus golden expand" },
		"bump-to": { type: "string", required: true, description: "Target golden version dir (e.g. v0.1.1)" },
		prior: { type: "string", default: "v0.1.0", description: "Previous version to forward-copy + dedup against" },
		"golden-root": { type: "string", default: "data/eval/golden", description: "Golden dir root" },
		filters: {
			type: "boolean",
			default: true,
			description: "Apply the human-typed-likelihood filters; pass --no-filters to skip them",
		},
		"dry-run": { type: "boolean", default: false, description: "Report what would be written but don't touch disk" },
	},
} as const satisfies CommandSpec

interface Options {
	input: string
	bumpTo: string
	prior: string
	goldenRoot: string
	filters: boolean
	dryRun: boolean
}

const CorpusGoldenPromote: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { promoteGolden } = await import("@mailwoman/corpus/tools")

		return promoteGolden(
			{
				input: options.input,
				bumpTo: options.bumpTo,
				prior: options.prior,
				goldenRoot: options.goldenRoot,
				noFilters: !options.filters,
				dryRun: options.dryRun,
			},
			(line) => console.error(line)
		)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ candidates {state.result.candidatesIn}, kept {state.result.kept}
				{options.dryRun ? " (dry-run)" : ` → ${options.goldenRoot}/${options.bumpTo}`}
			</Text>
		)
	}

	return null
}

export default CorpusGoldenPromote
