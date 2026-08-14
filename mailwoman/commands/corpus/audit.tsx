/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus audit <corpus-dir>` — per-source shard-count vs source_weight diagnostic.
 *   Pair with `--config` to weight the counts by a training YAML's source_weights block.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "audit",
	description: "Audit corpus shard counts against source weights.",
	positionals: [
		{ name: "corpus-dir", required: true, description: "Corpus directory (MANIFEST.json or train/val/test shards)" },
	],
	options: {
		config: { type: "string", description: "Training YAML whose source_weights pair with the shard counts" },
		sample: {
			type: "number",
			default: 100,
			description: "Max shards sampled per split when scanning without a MANIFEST",
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

		audit({ corpusDir: args[0], configPath: options.config, sampleShardCount: options.sample })
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	return null
}

export default CorpusAudit
