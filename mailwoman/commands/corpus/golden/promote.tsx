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

import { promoteGolden } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	input: zod.string().describe("Candidates JSONL from corpus golden expand"),
	bumpTo: zod.string().describe("Target golden version dir (e.g. v0.1.1)"),
	prior: zod.string().default("v0.1.0").describe("Previous version to forward-copy + dedup against"),
	goldenRoot: zod.string().default("data/eval/golden").describe("Golden dir root"),
	noFilters: zod.boolean().default(false).describe("Skip the human-typed-likelihood filters"),
	dryRun: zod.boolean().default(false).describe("Report what would be written but don't touch disk"),
})

export { OptionsSchema as options }

const CorpusGoldenPromote: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		promoteGolden(
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
	)

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
