/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus audit <corpus-dir>` — per-source shard-count vs source_weight diagnostic.
 *   Pair with `--config` to weight the counts by a training YAML's source_weights block.
 */

import { audit } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

export const args = zod.tuple([
	zod.string().describe(
		argument({
			name: "corpus-dir",
			description: "Corpus directory (MANIFEST.json or train/val/test shards)",
		})
	),
])

const OptionsSchema = zod.object({
	config: zod.string().optional().describe("Training YAML whose source_weights pair with the shard counts"),
	sample: zod.number().default(100).describe("Max shards sampled per split when scanning without a MANIFEST"),
})

export { OptionsSchema as options }

const CorpusAudit: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		audit({ corpusDir: args[0], configPath: options.config, sampleShardCount: options.sample })
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	return null
}

export default CorpusAudit
