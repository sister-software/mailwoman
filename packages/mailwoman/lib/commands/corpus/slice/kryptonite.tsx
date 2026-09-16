/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus slice kryptonite` — build a parquet file from the DeepSeek-generated
 *   kryptonite JSONL and emit the combined corpus MANIFEST (the base parquet files + the new one). See
 *   docs/engineering/reference/CORPUS_V0_4_0_GENERATION.md for the reproducibility contract.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "kryptonite",
	description: "Build a corpus parquet file from canonical kryptonite JSONL.",
	options: {
		jsonl: { type: "string", required: true, description: "Canonical kryptonite JSONL to convert" },
		"base-manifest": {
			type: "string",
			required: true,
			description: "Base corpus MANIFEST.json whose parquet files carry forward",
		},
		"out-dir": {
			type: "string",
			required: true,
			description: "Output directory (parquet files land under corpus-v<version>/)",
		},
		"corpus-version": { type: "string", default: "0.4.0", description: "Corpus version stamped into rows + MANIFEST" },
		source: {
			type: "string",
			default: "deepseek-kryptonite",
			description: "Source tag stamped on the new parquet file(s)",
		},
	},
} as const satisfies CommandSpec

const CorpusKryptoniteParquet: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildKryptoniteOverlay } = await import("@mailwoman/corpus/tools")

		await buildKryptoniteOverlay(
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

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") return <Text color="green">✓ kryptonite parquet built → {options.outDir}</Text>

	return null
}

export default CorpusKryptoniteParquet
