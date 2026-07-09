/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus shard kryptonite` — build a parquet shard from the DeepSeek-generated
 *   kryptonite JSONL and emit the combined corpus MANIFEST (base shards + the new shard). See
 *   docs/articles/plan/reference/CORPUS_V0_4_0_GENERATION.md for the reproducibility contract.
 */

import { buildKryptoniteShard } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	jsonl: zod.string().describe("Canonical kryptonite JSONL to shard"),
	baseManifest: zod.string().describe("Base corpus MANIFEST.json whose shards carry forward"),
	outDir: zod.string().describe("Output directory (shards land under corpus-v<version>/)"),
	corpusVersion: zod.string().default("0.4.0").describe("Corpus version stamped into rows + MANIFEST"),
	source: zod.string().default("deepseek-kryptonite").describe("Source tag stamped on the new shard(s)"),
})

export { OptionsSchema as options }

const CorpusShardKryptonite: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
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
