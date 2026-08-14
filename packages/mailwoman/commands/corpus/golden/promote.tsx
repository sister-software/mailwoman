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
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

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
		"no-filters": { type: "boolean", default: false, description: "Skip the human-typed-likelihood filters" },
		"dry-run": { type: "boolean", default: false, description: "Report what would be written but don't touch disk" },
	},
} as const satisfies CommandSpec

interface Options {
	input: string
	bumpTo: string
	prior: string
	goldenRoot: string
	noFilters: boolean
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
				noFilters: options.noFilters,
				dryRun: options.dryRun,
			},
			(line) => console.error(line)
		)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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
