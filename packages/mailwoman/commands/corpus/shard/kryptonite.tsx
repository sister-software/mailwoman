/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus shard kryptonite` — build a parquet shard from the DeepSeek-generated
 *   kryptonite JSONL and emit the combined corpus MANIFEST (base shards + the new shard). See
 *   docs/engineering/reference/CORPUS_V0_4_0_GENERATION.md for the reproducibility contract.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "kryptonite",
	description: "Build a corpus shard from canonical kryptonite JSONL.",
	options: {
		jsonl: { type: "string", required: true, description: "Canonical kryptonite JSONL to shard" },
		"base-manifest": {
			type: "string",
			required: true,
			description: "Base corpus MANIFEST.json whose shards carry forward",
		},
		"out-dir": {
			type: "string",
			required: true,
			description: "Output directory (shards land under corpus-v<version>/)",
		},
		"corpus-version": { type: "string", default: "0.4.0", description: "Corpus version stamped into rows + MANIFEST" },
		source: { type: "string", default: "deepseek-kryptonite", description: "Source tag stamped on the new shard(s)" },
	},
} as const satisfies CommandSpec

interface Options {
	jsonl: string
	baseManifest: string
	outDir: string
	corpusVersion: string
	source: string
}

const CorpusShardKryptonite: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildKryptoniteShard } = await import("@mailwoman/corpus/tools")

		await buildKryptoniteShard(
			{
				jsonl: options.jsonl,
				baseManifest: options.baseManifest,
				outDir: options.outDir,
				corpusVersion: options.corpusVersion,
				source: options.source,
			},
			(line) => console.error(line)
		)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ kryptonite shard built → {options.outDir}</Text>

	return null
}

export default CorpusShardKryptonite
