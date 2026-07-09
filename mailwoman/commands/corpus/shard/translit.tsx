/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus shard translit` — build per-script parquet shards from the DeepSeek-generated
 *   transliteration JSONL (one shard per `deepseek-translit-<slug>` source) and emit the combined
 *   corpus MANIFEST. Sibling of `corpus shard kryptonite`; also canonicalizes legacy base-shard
 *   paths (`/mnt/playpen/mailwoman-data/…` → `/data/…`).
 */

import { buildTranslitShard } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	jsonl: zod.string().describe("Canonical transliteration JSONL to shard"),
	baseManifest: zod.string().describe("Base corpus MANIFEST.json whose shards carry forward"),
	outDir: zod.string().describe("Output directory (shards land under corpus-v<version>/train/)"),
	corpusVersion: zod.string().default("0.4.0").describe("Corpus version stamped into rows + MANIFEST"),
	canonicalPathPrefix: zod.string().default("/data/").describe("Prefix replacing legacy base-shard paths"),
	legacyPathPrefix: zod
		.string()
		.default("/mnt/playpen/mailwoman-data/")
		.describe("Legacy base-shard path prefix to rewrite"),
})

export { OptionsSchema as options }

const CorpusShardTranslit: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
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
