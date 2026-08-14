/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus shard translit` — build per-script parquet shards from the DeepSeek-generated
 *   transliteration JSONL (one shard per `deepseek-translit-<slug>` source) and emit the combined
 *   corpus MANIFEST. Sibling of `corpus shard kryptonite`; also canonicalizes legacy base-shard
 *   paths (`$MAILWOMAN_DATA_ROOT/…` → `/data/…`).
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "translit",
	description: "Build transliteration corpus shards and their combined manifest.",
	options: {
		jsonl: { type: "string", required: true, description: "Canonical transliteration JSONL to shard" },
		"base-manifest": {
			type: "string",
			required: true,
			description: "Base corpus MANIFEST.json whose shards carry forward",
		},
		"out-dir": {
			type: "string",
			required: true,
			description: "Output directory (shards land under corpus-v<version>/train/)",
		},
		"corpus-version": { type: "string", default: "0.4.0", description: "Corpus version stamped into rows + MANIFEST" },
		"canonical-path-prefix": {
			type: "string",
			default: "/data/",
			description: "Prefix replacing legacy base-shard paths",
		},
		"legacy-path-prefix": {
			type: "string",
			description: "Legacy base-shard path prefix to rewrite (default: $MAILWOMAN_DATA_ROOT)",
		},
	},
} as const satisfies CommandSpec

interface Options {
	jsonl: string
	baseManifest: string
	outDir: string
	corpusVersion: string
	canonicalPathPrefix: string
	legacyPathPrefix?: string
}

const CorpusShardTranslit: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildTranslitShard } = await import("@mailwoman/corpus/tools")

		await buildTranslitShard(
			{
				jsonl: options.jsonl,
				baseManifest: options.baseManifest,
				outDir: options.outDir,
				corpusVersion: options.corpusVersion,
				canonicalPathPrefix: options.canonicalPathPrefix,
				legacyPathPrefix: options.legacyPathPrefix,
			},
			(line) => console.error(line)
		)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ transliteration shards built → {options.outDir}</Text>

	return null
}

export default CorpusShardTranslit
