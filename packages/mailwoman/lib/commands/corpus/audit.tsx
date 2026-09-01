/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus audit <corpus-dir>` — per-source slice-count vs source_weight diagnostic.
 *   Pair with `--config` to weight the counts by a training YAML's source_weights block.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "audit",
	description: "Audit corpus slice counts against source weights.",
	positionals: [
		{ name: "corpus-dir", required: true, description: "Corpus directory (MANIFEST.json or train/val/test slices)" },
	],
	options: {
		config: { type: "string", description: "Training YAML whose source_weights pair with the slice counts" },
		sample: {
			type: "number",
			default: 100,
			description: "Max slices sampled per split when scanning without a MANIFEST",
		},
	},
} as const satisfies CommandSpec

interface Options {
	config?: string
	sample: number
}

const CorpusAudit: ParsedCommandComponent<Options, [string]> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { audit } = await import("@mailwoman/corpus/tools")

		audit({ corpusDir: args[0], configPath: options.config, sampleSliceCount: options.sample })
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default CorpusAudit
